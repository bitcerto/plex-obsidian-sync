import { App } from "obsidian";
import { TECH_FILES } from "../core/constants";
import { syncShowHierarchy } from "./show-hierarchy-sync";
import {
  pruneInactiveAccountItems,
  syncDeletedAccountItems,
  syncDeletedPmsItems
} from "./sync-deletion-reconciliation";
import {
  enrichAccountItemForSync,
  fetchAccountItems,
  fetchTargetAccountItems,
  shouldProcessIncrementally
} from "./sync-item-selection";
import {
  readNoteFrontmatterFast,
  resolveNotePath,
  scanManagedNoteIndex
} from "./sync-note-paths";
import { fetchPlexItems, resolvePmsTarget } from "./sync-pms-source";
import {
  applyManagedSeriesSection,
  buildManagedMetadata,
  defaultBody,
  mergeFrontmatter,
  plexWatched,
  resolveConflictWinner
} from "../core/sync-core";
import { evaluateLock } from "../core/lock-core";
import {
  ensureMinNumber,
  isOnline,
  normalizeVaultPath,
  nowIso,
  parseBool,
  slugify
} from "../core/utils";
import type {
  PlexMediaItem,
  PlexSeasonInfo,
  PlexSyncSettings,
  SyncExecutionResult,
  SyncItemState,
  SyncLockFile,
  SyncOptions,
  SyncReport,
  SyncStateFile
} from "../types";
import { Logger } from "./logger";
import { PlexDiscoverClient } from "./plex-discover-client";
import { PmsClient } from "./plex-client";
import { VaultStore } from "./vault-store";

interface LockAcquireResult {
  acquired: boolean;
  reason?: string;
  lockPath: string;
}

interface SyncItemResult {
  state: SyncItemState;
  noteCreated: boolean;
  noteUpdated: boolean;
  plexUpdated: boolean;
  conflict: boolean;
}


interface SyncClient {
  markWatched(ratingKey: string, watched: boolean): Promise<void>;
  supportsSeasonWatchedWrites?: boolean;
  supportsShowWatchedWrites?: boolean;
  setWatchlisted?: (ratingKey: string, watchlisted: boolean) => Promise<void>;
  getShowSeasons?: (showRatingKey: string) => Promise<PlexSeasonInfo[]>;
}

export class SyncEngine {
  private app: App;
  private settingsProvider: () => PlexSyncSettings;
  private logger: Logger;
  private statusCallback?: (text: string) => void;
  private store: VaultStore;
  private deviceId: string;
  private isSyncRunning = false;
  private notePathByRatingKey = new Map<string, string>();
  private noteObservedWatchedByRatingKey = new Map<string, boolean>();
  private noteObservedWatchlistedByRatingKey = new Map<string, boolean>();
  private currentLockExpiresAtMs = 0;

  constructor(
    app: App,
    settingsProvider: () => PlexSyncSettings,
    logger: Logger,
    statusCallback?: (text: string) => void,
    deviceId?: string
  ) {
    this.app = app;
    this.settingsProvider = settingsProvider;
    this.logger = logger;
    this.statusCallback = statusCallback;
    this.store = new VaultStore(app, () => {
      const settings = this.settingsProvider();
      return {
        frontmatterKeyLanguage: settings.frontmatterKeyLanguage,
        obsidianLocale: settings.obsidianLocale,
        plexAccountLocale: settings.plexAccountLocale
      };
    });
    this.deviceId = deviceId && deviceId.trim().length > 0 ? deviceId.trim() : buildDeviceId();
  }

  async runSync(options: SyncOptions): Promise<SyncExecutionResult> {
    if (this.isSyncRunning) {
      const report = this.buildReport(options.reason);
      report.skipped = "sync ja em andamento neste dispositivo";
      report.finishedAt = nowIso();
      await this.persistReport(report);
      return { report, skipped: true };
    }

    this.isSyncRunning = true;
    const settings = this.settingsProvider();
    const report = this.buildReport(options.reason);
    const lockPath = this.getLockPath(settings);
    let lockAcquired = false;

    try {
      if (settings.syncOnlyWhenOnline && !isOnline()) {
        report.skipped = "dispositivo offline, sync ignorado";
        return { report, skipped: true };
      }

      this.emitStatus("Plex Sync: adquirindo lock...");
      const lockResult = await this.acquireLock(settings);
      if (!lockResult.acquired) {
        report.skipped = lockResult.reason || "lock em uso por outro dispositivo";
        report.lockOwner = lockResult.reason;
        return { report, skipped: true };
      }

      lockAcquired = true;
      await this.store.ensureFolder(settings.notesFolder);
      await this.writeServersCache();
      const noteIndex = await scanManagedNoteIndex({
        app: this.app,
        store: this.store,
        noteRoot: settings.notesFolder
      });
      this.notePathByRatingKey = noteIndex.mapping;
      this.noteObservedWatchedByRatingKey = noteIndex.observedWatchedByRatingKey;
      this.noteObservedWatchlistedByRatingKey = noteIndex.observedWatchlistedByRatingKey;

      const statePath = this.getStatePath(settings);
      const legacyStatePath = this.getLegacyStatePath(settings);
      if (options.forceFullRebuild) {
        await this.store.removeAdapterFile(statePath);
      }

      const fallbackStatePath =
        legacyStatePath !== statePath ? legacyStatePath : undefined;
      const state = await this.loadState(statePath, fallbackStatePath);
      const targetRatingKeys = normalizeRatingKeys(options.targetRatingKeys);
      const deletedRatingKeys = normalizeRatingKeys(options.deletedRatingKeys);
      const timeoutSeconds = ensureMinNumber(settings.requestTimeoutSeconds, 5);
      let removedByDeletedNotes = new Set<string>();
      let client: SyncClient;
      let accountClientForDetails: PlexDiscoverClient | undefined;
      let items: PlexMediaItem[] = [];
      let posterUrlBuilder: ((thumb: string | undefined) => string | undefined) | undefined;

      if (settings.authMode === "account_only") {
        if (!settings.plexAccountToken.trim()) {
          throw new Error("modo conta Plex: faça login primeiro (Plex Sync: Login with Plex Account)");
        }
        const discoverClient = new PlexDiscoverClient(
          {
            accountToken: settings.plexAccountToken,
            clientIdentifier: settings.plexClientIdentifier,
            product: "Plex Sync",
            timeoutSeconds,
            locale: settings.obsidianLocale || settings.plexAccountLocale
          },
          this.logger
        );
        client = discoverClient;
        accountClientForDetails = discoverClient;
        report.resolvedServer = "Conta Plex";
        const accountToken = settings.plexAccountToken.trim();
        posterUrlBuilder = (thumb: string | undefined): string | undefined => {
          if (!thumb) return undefined;
          if (thumb.startsWith("http")) return thumb;
          return accountToken ? `https://metadata.provider.plex.tv${thumb}?X-Plex-Token=${accountToken}` : undefined;
        };
        report.resolvedConnectionUri = "https://discover.provider.plex.tv";
        removedByDeletedNotes = await syncDeletedAccountItems({
          client: discoverClient,
          state,
          report,
          explicitDeletedRatingKeys: deletedRatingKeys,
          context: {
            logger: this.logger,
            notePathByRatingKey: this.notePathByRatingKey
          },
          emitStatus: (text) => this.emitStatus(text)
        });
        if (targetRatingKeys.size > 0 && !options.forceFullRebuild) {
          this.emitStatus(`Plex Sync: carregando ${targetRatingKeys.size} item(ns) alvo...`);
          items = await fetchTargetAccountItems({
            client: discoverClient,
            ratingKeys: Array.from(targetRatingKeys),
            excludedKeys: removedByDeletedNotes,
            logger: this.logger
          });
        } else {
          this.emitStatus("Plex Sync: carregando watchlist e histórico assistido da conta...");
          items = await fetchAccountItems({
            client: discoverClient,
            state,
            noteTrackedKeys: Array.from(this.notePathByRatingKey.keys()),
            excludedKeys: removedByDeletedNotes,
            trackedLookupLimit: options.forceFullRebuild ? 200 : options.reason === "manual" ? 10 : 20,
            logger: this.logger
          });
        }
        const removedByAccountRules = await pruneInactiveAccountItems({
          noteRoot: settings.notesFolder,
          items,
          state,
          context: {
            app: this.app,
            logger: this.logger,
            notePathByRatingKey: this.notePathByRatingKey,
            readNoteFrontmatterFast: (path) => readNoteFrontmatterFast(this.app, this.store, path),
            removeAdapterFile: (path) => this.store.removeAdapterFile(path),
            fileExists: (path) => this.store.fileExists(path)
          }
        });
        if (removedByAccountRules.size > 0) {
          for (const ratingKey of removedByAccountRules) {
            removedByDeletedNotes.add(ratingKey);
          }
          items = items.filter((item) => !removedByAccountRules.has(item.ratingKey));
          report.updatedNotes += removedByAccountRules.size;
        }
      } else {
        const target = await resolvePmsTarget({
          settings,
          logger: this.logger
        });
        report.resolvedServer = target.serverName;
        report.resolvedConnectionUri = target.connectionUri || target.baseUrl;
        const pmsClient = new PmsClient(
          {
            baseUrl: target.baseUrl,
            token: target.token,
            timeoutSeconds
          },
          this.logger
        );
        client = pmsClient;
        posterUrlBuilder = (thumb: string | undefined): string | undefined => {
          if (!thumb) return undefined;
          if (thumb.startsWith("http")) return thumb;
          return `${target.baseUrl}${thumb}?X-Plex-Token=${target.token}`;
        };
        removedByDeletedNotes = await syncDeletedPmsItems({
          pmsClient,
          state,
          report,
          explicitDeletedRatingKeys: deletedRatingKeys,
          accountClient:
            settings.authMode === "hybrid_account" && settings.plexAccountToken.trim()
              ? new PlexDiscoverClient(
                  {
                    accountToken: settings.plexAccountToken,
                    clientIdentifier: settings.plexClientIdentifier,
                    product: "Plex Sync",
                    timeoutSeconds,
                    locale: settings.obsidianLocale || settings.plexAccountLocale
                  },
                  this.logger
                )
              : undefined,
          context: {
            logger: this.logger,
            notePathByRatingKey: this.notePathByRatingKey
          },
          emitStatus: (text) => this.emitStatus(text)
        });
        this.emitStatus("Plex Sync: carregando bibliotecas...");
        items = await fetchPlexItems({
          client: pmsClient,
          settings,
          logger: this.logger
        });
        if (removedByDeletedNotes.size > 0) {
          items = items.filter((item) => !removedByDeletedNotes.has(item.ratingKey));
        }
      }

      const nextItems: Record<string, SyncItemState> = {};
      const preferredObsidianKeys = new Set<string>(
        Array.isArray(options.preferredObsidianKeys)
          ? options.preferredObsidianKeys
              .filter((entry) => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : []
      );
      const preferredObsidianWatchedByKey = new Map<string, boolean>(
        options.preferredObsidianWatchedByKey
          ? Object.entries(options.preferredObsidianWatchedByKey).filter(
              (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
            )
          : []
      );

      const processQueue: PlexMediaItem[] = [];
      const forceFullRebuild = options.forceFullRebuild === true;
      for (const item of items) {
        const prev = state.items[item.ratingKey];
        const currentNotePath = this.notePathByRatingKey.get(item.ratingKey);
        const forceTargetedSync = targetRatingKeys.has(item.ratingKey);
        const preferObsidianWhenStateMissing = preferredObsidianKeys.has(item.ratingKey);
        const preferredObsidianWatched = preferredObsidianWatchedByKey.get(item.ratingKey);

        const shouldProcess = shouldProcessIncrementally({
          item,
          previousState: prev,
          currentNotePath,
          forceTargetedSync,
          preferObsidianWhenStateMissing,
          preferredObsidianWatched,
          forceFullRebuild,
          observedObsidianWatched: this.noteObservedWatchedByRatingKey.get(item.ratingKey),
          observedObsidianWatchlisted: this.noteObservedWatchlistedByRatingKey.get(item.ratingKey)
        });
        if (shouldProcess) {
          processQueue.push(item);
          continue;
        }

        if (prev) {
          nextItems[item.ratingKey] = {
            ...prev,
            notePath: currentNotePath || prev.notePath
          };
        }
      }

      report.totalItems = processQueue.length;

      for (let index = 0; index < processQueue.length; index += 1) {
        let item = processQueue[index];
        const prev = state.items[item.ratingKey];

        try {
          await this.extendLock(settings, lockPath);
          this.emitStatus(`Plex Sync: ${index + 1}/${processQueue.length}`);

          if (accountClientForDetails) {
            item = await enrichAccountItemForSync({
              client: accountClientForDetails,
              item,
              logger: this.logger
            });
          }

          const result = await this.syncSingleItem(
            item,
            prev,
            settings,
            client,
            preferredObsidianKeys.has(item.ratingKey),
            preferredObsidianWatchedByKey.get(item.ratingKey),
            posterUrlBuilder,
            options.overrideSeasonRatingKeys,
            options.overrideEpisodeRatingKeys,
            options.overrideSeasonWatchedByKey,
            options.overrideEpisodeWatchedByKey,
            options.overrideSeasonCheckboxSnapshotsByKey
          );
          if (result.noteCreated) {
            report.createdNotes += 1;
          }
          if (result.noteUpdated) {
            report.updatedNotes += 1;
          }
          if (result.plexUpdated) {
            report.updatedPlex += 1;
          }
          if (result.conflict) {
            report.conflicts += 1;
          }
          nextItems[item.ratingKey] = result.state;
        } catch (error) {
          const message = `Falha item ${item.ratingKey} (${item.title}): ${String(error)}`;
          this.logger.error(message);
          report.errors.push(message);
          if (prev) {
            nextItems[item.ratingKey] = prev;
          }
        }
      }

      if (settings.authMode === "account_only") {
        for (const [ratingKey, prev] of Object.entries(state.items)) {
          if (removedByDeletedNotes.has(ratingKey)) {
            continue;
          }
          if (!nextItems[ratingKey]) {
            nextItems[ratingKey] = prev;
          }
        }
      }

      const finalState: SyncStateFile = {
        version: 1,
        items: nextItems,
        lastRunAt: nowIso()
      };
      await this.store.writeJson(statePath, finalState);

      return { report, skipped: false };
    } catch (error) {
      const message = `Erro no sync: ${String(error)}`;
      report.errors.push(message);
      this.logger.error(message, error);
      return { report, skipped: false };
    } finally {
      report.finishedAt = nowIso();
      await this.persistReport(report);
      if (lockAcquired) {
        await this.releaseLock(lockPath);
      }
      this.emitStatus("Plex Sync: idle");
      this.isSyncRunning = false;
      this.notePathByRatingKey.clear();
      this.noteObservedWatchedByRatingKey.clear();
      this.noteObservedWatchlistedByRatingKey.clear();
    }
  }

  async resetState(): Promise<void> {
    const settings = this.settingsProvider();
    await this.store.removeAdapterFile(this.getStatePath(settings));
  }

  async readLastReport(): Promise<SyncReport | undefined> {
    const settings = this.settingsProvider();
    return this.store.readJson<SyncReport>(this.getReportPath(settings));
  }

  async writeServersCache(): Promise<void> {
    const settings = this.settingsProvider();
    const sanitizedServers = settings.serversCache.map((server) => ({
      machineId: server.machineId,
      name: server.name,
      owned: server.owned,
      sourceTitle: server.sourceTitle,
      provides: [...server.provides],
      updatedAt: server.updatedAt,
      connections: server.connections.map((connection) => ({
        local: connection.local,
        protocol: connection.protocol,
        port: connection.port,
        relay: connection.relay,
        ipv6: connection.ipv6
      }))
    }));
    const payload = {
      updatedAt: nowIso(),
      authMode: settings.authMode,
      servers: sanitizedServers
    };
    await this.store.writeJson(this.getServersCachePath(settings), payload);
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  private async syncSingleItem(
    item: PlexMediaItem,
    previousState: SyncItemState | undefined,
    settings: PlexSyncSettings,
    client: SyncClient,
    preferObsidianWhenStateMissing = false,
    preferredObsidianWatched?: boolean,
    posterUrlBuilder?: (thumb: string | undefined) => string | undefined,
    overrideSeasonRatingKeys?: Set<string>,
    overrideEpisodeRatingKeys?: Set<string>,
    overrideSeasonWatchedByKey?: Map<string, boolean>,
    overrideEpisodeWatchedByKey?: Map<string, boolean>,
    overrideSeasonCheckboxSnapshotsByKey?: Map<string, string>
  ): Promise<SyncItemResult> {
    const noteRoot = normalizeVaultPath(settings.notesFolder);
    const previousRelPath = previousState?.notePath;
    const { absolutePath, relativePath } = await resolveNotePath({
      item,
      noteRoot,
      previousRelativePath: previousRelPath,
      settings,
      mappedRelativePath: this.notePathByRatingKey.get(item.ratingKey),
      store: this.store
    });

    const note = await this.store.readNote(absolutePath);
    const existingMeta = note.frontmatter;
    let existingBody = note.body;

    let plexCurrentWatched = plexWatched(item);
    let plexCurrentWatchlisted = parseBool(item.inWatchlist, false);
    let obsidianWatched = note.exists
      ? parseBool(existingMeta.assistido, plexCurrentWatched)
      : plexCurrentWatched;
    let obsidianWatchlisted = note.exists
      ? parseBool(
          existingMeta.na_lista_para_assistir ?? existingMeta.na_watchlist,
          plexCurrentWatchlisted
        )
      : plexCurrentWatchlisted;

    if (typeof preferredObsidianWatched === "boolean") {
      obsidianWatched = preferredObsidianWatched;
    }

    const hasPrevious = Boolean(previousState);
    const prevPlexWatched = parseBool(previousState?.plexWatched, plexCurrentWatched);
    const prevObsidianWatched = parseBool(previousState?.obsidianWatched, obsidianWatched);
    const prevPlexWatchlisted = parseBool(previousState?.plexWatchlisted, plexCurrentWatchlisted);
    const prevObsidianWatchlisted = parseBool(
      previousState?.obsidianWatchlisted,
      obsidianWatchlisted
    );

    const plexChanged = hasPrevious && plexCurrentWatched !== prevPlexWatched;
    const obsidianChanged = hasPrevious && note.exists && obsidianWatched !== prevObsidianWatched;
    const plexWatchlistedChanged = hasPrevious && plexCurrentWatchlisted !== prevPlexWatchlisted;
    const obsidianWatchlistedChanged =
      hasPrevious && note.exists && obsidianWatchlisted !== prevObsidianWatchlisted;

    let noteCreated = false;
    let noteUpdated = false;
    let plexUpdated = false;
    let conflict = false;
    let syncSource = "none";
    const supportsWatchlist = typeof client.setWatchlisted === "function";
    let forcedObsidianApplied = false;
    let deferredShowWatchedOverride: boolean | undefined;
    const deferShowWatchedWrite =
      item.type === "show" &&
      typeof client.getShowSeasons === "function" &&
      client.supportsShowWatchedWrites === false;

    if (preferObsidianWhenStateMissing) {
      if (obsidianWatched !== plexCurrentWatched) {
        if (!deferShowWatchedWrite) {
          await client.markWatched(item.ratingKey, obsidianWatched);
          plexCurrentWatched = obsidianWatched;
          plexUpdated = true;
        } else {
          deferredShowWatchedOverride = obsidianWatched;
        }
        forcedObsidianApplied = true;
      }
    } else if (!hasPrevious) {
      syncSource = "plex";
    } else if (plexChanged && !obsidianChanged) {
      obsidianWatched = plexCurrentWatched;
      syncSource = "plex";
    } else if (obsidianChanged && !plexChanged) {
      if (obsidianWatched !== plexCurrentWatched) {
        if (!deferShowWatchedWrite) {
          await client.markWatched(item.ratingKey, obsidianWatched);
          plexCurrentWatched = obsidianWatched;
          plexUpdated = true;
        } else {
          deferredShowWatchedOverride = obsidianWatched;
        }
      }
      syncSource = "obsidian";
    } else if (obsidianChanged && plexChanged && obsidianWatched !== plexCurrentWatched) {
      conflict = true;
      const winner = resolveConflictWinner(
        settings.conflictPolicy,
        note.mtimeMs,
        item.lastViewedAt,
        item.updatedAt
      );

      if (winner === "obsidian") {
        if (!deferShowWatchedWrite) {
          await client.markWatched(item.ratingKey, obsidianWatched);
          plexCurrentWatched = obsidianWatched;
          plexUpdated = true;
        } else {
          deferredShowWatchedOverride = obsidianWatched;
        }
        syncSource = "obsidian";
      } else {
        obsidianWatched = plexCurrentWatched;
        syncSource = "plex";
      }
    } else if (obsidianChanged && plexChanged && obsidianWatched === plexCurrentWatched) {
      syncSource = "both";
    }

    if (supportsWatchlist) {
      if (preferObsidianWhenStateMissing) {
        if (obsidianWatchlisted !== plexCurrentWatchlisted) {
          await client.setWatchlisted!(item.ratingKey, obsidianWatchlisted);
          plexCurrentWatchlisted = obsidianWatchlisted;
          plexUpdated = true;
          forcedObsidianApplied = true;
        }
      } else if (!hasPrevious) {
        syncSource = mergeSyncSource(syncSource, "plex");
      } else if (plexWatchlistedChanged && !obsidianWatchlistedChanged) {
        obsidianWatchlisted = plexCurrentWatchlisted;
        syncSource = mergeSyncSource(syncSource, "plex");
      } else if (obsidianWatchlistedChanged && !plexWatchlistedChanged) {
        if (obsidianWatchlisted !== plexCurrentWatchlisted) {
          await client.setWatchlisted(item.ratingKey, obsidianWatchlisted);
          plexCurrentWatchlisted = obsidianWatchlisted;
          plexUpdated = true;
        }
        syncSource = mergeSyncSource(syncSource, "obsidian");
      } else if (
        obsidianWatchlistedChanged &&
        plexWatchlistedChanged &&
        obsidianWatchlisted !== plexCurrentWatchlisted
      ) {
        conflict = true;
        const winner = resolveConflictWinner(
          settings.conflictPolicy,
          note.mtimeMs,
          item.lastViewedAt,
          item.updatedAt
        );

        if (winner === "obsidian") {
          await client.setWatchlisted(item.ratingKey, obsidianWatchlisted);
          plexCurrentWatchlisted = obsidianWatchlisted;
          plexUpdated = true;
          syncSource = mergeSyncSource(syncSource, "obsidian");
        } else {
          obsidianWatchlisted = plexCurrentWatchlisted;
          syncSource = mergeSyncSource(syncSource, "plex");
        }
      } else if (
        obsidianWatchlistedChanged &&
        plexWatchlistedChanged &&
        obsidianWatchlisted === plexCurrentWatchlisted
      ) {
        syncSource = "both";
      }

    } else {
      obsidianWatchlisted = plexCurrentWatchlisted;
    }

    if (forcedObsidianApplied) {
      syncSource = mergeSyncSource(syncSource, "obsidian");
    }

    if (!note.exists) {
      existingBody = defaultBody(item.title, posterUrlBuilder?.(item.thumb));
      noteCreated = true;
    }

    if (item.type === "show" && typeof client.getShowSeasons === "function") {
      try {
        item.seasons = await client.getShowSeasons(item.ratingKey);
      } catch (error) {
        this.logger.debug("falha ao carregar temporadas/episodios", {
          ratingKey: item.ratingKey,
          error: String(error)
        });
      }
    }

    if (item.type === "show") {
      const showWatchedOverride =
        typeof deferredShowWatchedOverride === "boolean"
          ? deferredShowWatchedOverride
          : obsidianChanged && syncSource !== "plex"
            ? obsidianWatched
            : undefined;
      const hierarchy = await syncShowHierarchy({
        app: this.app,
        noteRoot,
        showNoteRelativePath: relativePath,
        showItem: item,
        client,
        showWatchedOverride,
        overrideSeasonRatingKeys,
        overrideEpisodeRatingKeys,
        overrideSeasonWatchedByKey,
        overrideEpisodeWatchedByKey,
        overrideSeasonCheckboxSnapshotsByKey,
        logger: this.logger,
        store: this.store,
        posterUrlBuilder
      });
      if (hierarchy.noteChanged) {
        noteUpdated = true;
      }
      if (hierarchy.plexUpdated) {
        plexUpdated = true;
      }
      if (deferShowWatchedWrite && typeof showWatchedOverride === "boolean") {
        plexCurrentWatched = showWatchedOverride;
      }
    }

    const finalWatched = plexCurrentWatched;
    item.inWatchlist = supportsWatchlist ? plexCurrentWatchlisted : undefined;
    const managedMeta = buildManagedMetadata({
      item,
      watched: finalWatched,
      syncSource,
      existingMeta,
      noteExists: note.exists
    });

    const mergedFrontmatter = mergeFrontmatter(existingMeta, managedMeta);
    const managedBody = applyManagedSeriesSection(existingBody, item);
    const rendered = this.store.renderMarkdown(mergedFrontmatter, managedBody);

    if (!note.exists || rendered !== note.content) {
      await this.store.writeNote(absolutePath, rendered);
      noteUpdated = true;
    }

    const watchedForState = parseBool(mergedFrontmatter.assistido, plexCurrentWatched);
    const watchlistedForState = parseBool(
      mergedFrontmatter.na_lista_para_assistir ?? mergedFrontmatter.na_watchlist,
      plexCurrentWatchlisted
    );
    const state: SyncItemState = {
      notePath: relativePath,
      plexWatched: plexCurrentWatched,
      obsidianWatched: watchedForState,
      plexWatchlisted: supportsWatchlist ? plexCurrentWatchlisted : undefined,
      obsidianWatchlisted: supportsWatchlist ? watchlistedForState : undefined,
      plexUpdatedAt: item.updatedAt,
      plexLastViewedAt: item.lastViewedAt,
      lastSyncAt: nowIso(),
      lastSyncEpoch: Date.now()
    };

    return {
      state,
      noteCreated,
      noteUpdated,
      plexUpdated,
      conflict
    };
  }

  private buildReport(reason: string): SyncReport {
    return {
      startedAt: nowIso(),
      finishedAt: nowIso(),
      reason,
      totalItems: 0,
      createdNotes: 0,
      updatedNotes: 0,
      updatedPlex: 0,
      conflicts: 0,
      errors: [],
      deviceId: this.deviceId
    };
  }

  private async loadState(path: string, fallbackPath?: string): Promise<SyncStateFile> {
    let raw = await this.store.readJson<SyncStateFile>(path);
    if (!raw && fallbackPath) {
      raw = await this.store.readJson<SyncStateFile>(fallbackPath);
    }
    if (!raw || typeof raw !== "object") {
      return { version: 1, items: {} };
    }

    return {
      version: 1,
      items: raw.items && typeof raw.items === "object" ? raw.items : {},
      lastRunAt: raw.lastRunAt
    };
  }

  private getStatePath(settings: PlexSyncSettings): string {
    if (settings.authMode === "account_only") {
      const scope = buildAccountStateScope(settings);
      return normalizeVaultPath(settings.notesFolder, `${TECH_FILES.state.slice(0, -5)}-${scope}.json`);
    }
    return normalizeVaultPath(settings.notesFolder, TECH_FILES.state);
  }

  private getLegacyStatePath(settings: PlexSyncSettings): string {
    return normalizeVaultPath(settings.notesFolder, TECH_FILES.state);
  }

  private getLockPath(settings: PlexSyncSettings): string {
    return normalizeVaultPath(settings.notesFolder, TECH_FILES.lock);
  }

  private getReportPath(settings: PlexSyncSettings): string {
    return normalizeVaultPath(settings.notesFolder, TECH_FILES.report);
  }

  private getServersCachePath(settings: PlexSyncSettings): string {
    return normalizeVaultPath(settings.notesFolder, TECH_FILES.serversCache);
  }

  private async acquireLock(settings: PlexSyncSettings): Promise<LockAcquireResult> {
    const lockPath = this.getLockPath(settings);
    const now = Date.now();
    const current = await this.store.readJson<SyncLockFile>(lockPath);
    const decision = evaluateLock(current, this.deviceId, now);

    if (!decision.acquired) {
      return {
        acquired: false,
        reason: decision.reason,
        lockPath
      };
    }

    const ttl = ensureMinNumber(settings.lockTtlSeconds, 30) * 1000;
    const lock: SyncLockFile = {
      deviceId: this.deviceId,
      acquiredAt: now,
      expiresAt: now + ttl
    };

    await this.store.writeJson(lockPath, lock);
    this.currentLockExpiresAtMs = lock.expiresAt;
    return {
      acquired: true,
      lockPath
    };
  }

  private async extendLock(settings: PlexSyncSettings, lockPath: string): Promise<void> {
    const ttl = ensureMinNumber(settings.lockTtlSeconds, 30) * 1000;
    const now = Date.now();
    const refreshWindow = Math.max(10_000, Math.floor(ttl / 3));
    if (this.currentLockExpiresAtMs - now > refreshWindow) {
      return;
    }

    const lock: SyncLockFile = {
      deviceId: this.deviceId,
      acquiredAt: now,
      expiresAt: now + ttl
    };
    await this.store.writeJson(lockPath, lock);
    this.currentLockExpiresAtMs = lock.expiresAt;
  }

  private async releaseLock(lockPath: string): Promise<void> {
    const current = await this.store.readJson<SyncLockFile>(lockPath);
    if (!current || current.deviceId !== this.deviceId) {
      return;
    }
    await this.store.removeAdapterFile(lockPath);
    this.currentLockExpiresAtMs = 0;
  }

  private async persistReport(report: SyncReport): Promise<void> {
    const settings = this.settingsProvider();
    await this.store.writeJson(this.getReportPath(settings), report);
  }

  private emitStatus(text: string): void {
    this.statusCallback?.(text);
  }
}

function buildDeviceId(): string {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `device-${now}-${rand}`;
}

function normalizeRatingKeys(values?: string[]): Set<string> {
  if (!Array.isArray(values)) {
    return new Set<string>();
  }
  return new Set<string>(
    values
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}


function mergeSyncSource(current: string, incoming: "plex" | "obsidian" | "both"): string {
  if (incoming === "both" || current === "both") {
    return "both";
  }
  if (current === "none") {
    return incoming;
  }
  if (current === incoming) {
    return current;
  }
  return "both";
}

function buildAccountStateScope(settings: PlexSyncSettings): string {
  const email = settings.plexAccountEmail?.trim().toLowerCase();
  if (email) {
    return slugify(email);
  }

  const clientIdentifier = settings.plexClientIdentifier?.trim();
  if (clientIdentifier) {
    return slugify(clientIdentifier);
  }

  return "account";
}
