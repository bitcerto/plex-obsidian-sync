import { App } from "obsidian";
import { TECH_FILES } from "../core/constants";
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
  orderConnections,
  tokenCandidates
} from "../core/plex-account-core";
import {
  ensureMinNumber,
  isOnline,
  normalizeVaultPath,
  nowIso,
  parseBool
} from "../core/utils";
import type {
  PlexMediaItem,
  PlexSeasonInfo,
  PlexSection,
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

interface ResolvedPmsTarget {
  baseUrl: string;
  token: string;
  serverName?: string;
  machineId?: string;
  connectionUri?: string;
}

interface SyncClient {
  markWatched(ratingKey: string, watched: boolean): Promise<void>;
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
    this.store = new VaultStore(app);
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
      this.notePathByRatingKey = await this.scanNotePathsByRatingKey(settings.notesFolder);

      const statePath = this.getStatePath(settings);
      if (options.forceFullRebuild) {
        await this.store.removeAdapterFile(statePath);
      }

      const state = await this.loadState(statePath);
      const timeoutSeconds = ensureMinNumber(settings.requestTimeoutSeconds, 5);
      let removedByDeletedNotes = new Set<string>();

      let client: SyncClient;
      let items: PlexMediaItem[] = [];

      if (settings.authMode === "account_only") {
        if (!settings.plexAccountToken.trim()) {
          throw new Error("modo conta Plex: faca login primeiro (Plex Sync: Login with Plex Account)");
        }
        const discoverClient = new PlexDiscoverClient(
          {
            accountToken: settings.plexAccountToken,
            clientIdentifier: settings.plexClientIdentifier,
            product: "Plex Obsidian Sync",
            timeoutSeconds
          },
          this.logger
        );
        client = discoverClient;
        report.resolvedServer = "Conta Plex";
        report.resolvedConnectionUri = "https://discover.provider.plex.tv";
        removedByDeletedNotes = await this.syncDeletedAccountItems(discoverClient, state, report);
        this.emitStatus("Plex Sync: carregando watchlist da conta...");
        items = await this.fetchAccountItems(
          discoverClient,
          state,
          Array.from(this.notePathByRatingKey.keys()),
          removedByDeletedNotes
        );
      } else {
        const target = await this.resolvePmsTarget(settings);
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
        this.emitStatus("Plex Sync: carregando bibliotecas...");
        items = await this.fetchPlexItems(pmsClient, settings);
      }

      report.totalItems = items.length;

      const nextItems: Record<string, SyncItemState> = {};

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const prev = state.items[item.ratingKey];

        try {
          await this.extendLock(settings, lockPath);
          this.emitStatus(`Plex Sync: ${index + 1}/${items.length}`);

          const result = await this.syncSingleItem(item, prev, settings, client);
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
    const payload = {
      updatedAt: nowIso(),
      authMode: settings.authMode,
      servers: settings.serversCache
    };
    await this.store.writeJson(this.getServersCachePath(settings), payload);
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  private async fetchPlexItems(client: PmsClient, settings: PlexSyncSettings): Promise<PlexMediaItem[]> {
    const sections = await client.listSections();
    if (sections.length === 0) {
      throw new Error(
        "Plex retornou zero bibliotecas. Crie pelo menos uma biblioteca de Filmes ou Programas de TV no servidor."
      );
    }

    const targetSections = this.pickTargetSections(sections, settings);
    if (targetSections.length === 0) {
      const available = sections
        .filter((section) => section.type === "movie" || section.type === "show")
        .map((section) => `${section.title} (${section.type})`);

      if (available.length === 0) {
        throw new Error(
          "Nenhuma biblioteca do tipo movie/show foi encontrada no Plex. O plugin sincroniza apenas Filmes e Programas de TV."
        );
      }

      throw new Error(
        `Nenhuma biblioteca selecionada corresponde ao servidor. Disponiveis: ${available.join(", ")}`
      );
    }

    const allItems: PlexMediaItem[] = [];
    for (const section of targetSections) {
      const items = await client.listLibraryItems(section.key, section.title);
      allItems.push(...items);
    }

    const dedup = new Map<string, PlexMediaItem>();
    for (const item of allItems) {
      dedup.set(item.ratingKey, item);
    }

    return Array.from(dedup.values());
  }

  private async fetchAccountItems(
    client: PlexDiscoverClient,
    state: SyncStateFile,
    noteTrackedKeys: string[],
    excludedKeys: Set<string>
  ): Promise<PlexMediaItem[]> {
    const watchlistItems = await client.listWatchlist();
    const dedup = new Map<string, PlexMediaItem>(
      watchlistItems
        .filter((item) => !excludedKeys.has(item.ratingKey))
        .map((item) => [item.ratingKey, item])
    );

    const trackedKeys = new Set<string>(
      [...Object.keys(state.items), ...noteTrackedKeys].filter((ratingKey) => !excludedKeys.has(ratingKey))
    );
    for (const ratingKey of trackedKeys) {
      if (dedup.has(ratingKey)) {
        continue;
      }

      try {
        const tracked = await client.getTrackedItem(ratingKey);
        if (tracked) {
          dedup.set(ratingKey, tracked);
        }
      } catch (error) {
        this.logger.debug("falha ao carregar item rastreado da conta", {
          ratingKey,
          error: String(error)
        });
      }
    }

    return Array.from(dedup.values());
  }

  private async syncDeletedAccountItems(
    client: PlexDiscoverClient,
    state: SyncStateFile,
    report: SyncReport
  ): Promise<Set<string>> {
    const removed = new Set<string>();
    const candidates = this.findDeletedNoteCandidates(state);
    if (candidates.length === 0) {
      return removed;
    }

    // Protecao contra remocao em massa acidental por mudanca de pasta/config.
    if (this.notePathByRatingKey.size === 0 && Object.keys(state.items).length > 0) {
      const message =
        "Exclusoes de notas detectadas, mas nenhuma nota Plex foi encontrada no vault atual. Remocao no Plex ignorada para evitar apagamento em massa.";
      this.logger.warn(message);
      report.errors.push(message);
      return removed;
    }

    this.emitStatus(`Plex Sync: processando ${candidates.length} exclusao(oes) de nota...`);

    for (const ratingKey of candidates) {
      const failures: string[] = [];
      let changed = false;

      try {
        await client.setWatchlisted(ratingKey, false);
        changed = true;
      } catch (error) {
        failures.push(`watchlist: ${String(error)}`);
      }

      try {
        await client.markWatched(ratingKey, false);
        changed = true;
      } catch (error) {
        failures.push(`assistido: ${String(error)}`);
      }

      if (changed) {
        removed.add(ratingKey);
        report.updatedPlex += 1;
      } else {
        const message = `Falha ao propagar exclusao da nota ${ratingKey} para o Plex: ${failures.join(" | ")}`;
        this.logger.error(message);
        report.errors.push(message);
      }
    }

    return removed;
  }

  private findDeletedNoteCandidates(state: SyncStateFile): string[] {
    const deleted: string[] = [];

    for (const [ratingKey, itemState] of Object.entries(state.items)) {
      if (!itemState.notePath) {
        continue;
      }
      if (this.notePathByRatingKey.has(ratingKey)) {
        continue;
      }
      deleted.push(ratingKey);
    }

    return deleted;
  }

  private async scanNotePathsByRatingKey(noteRoot: string): Promise<Map<string, string>> {
    const root = normalizeVaultPath(noteRoot);
    const rootPrefix = root.length > 0 ? `${root}/` : "";
    const mapping = new Map<string, string>();

    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const filePath = normalizeVaultPath(file.path);
      if (!filePath.startsWith(rootPrefix)) {
        continue;
      }

      const note = await this.store.readNote(filePath);
      const ratingKey = note.frontmatter.plex_rating_key;
      if (typeof ratingKey !== "string" || ratingKey.trim().length === 0) {
        continue;
      }

      const relativePath = filePath.slice(rootPrefix.length);
      mapping.set(ratingKey.trim(), relativePath);
    }

    return mapping;
  }

  private pickTargetSections(sections: PlexSection[], settings: PlexSyncSettings): PlexSection[] {
    const requested = settings.libraries.map((entry) => entry.trim()).filter(Boolean);

    if (requested.length === 0) {
      return sections.filter((section) => section.type === "movie" || section.type === "show");
    }

    const byTitle = new Map<string, PlexSection>(
      sections.map((section) => [section.title.toLowerCase(), section])
    );

    const selected: PlexSection[] = [];
    for (const name of requested) {
      const section = byTitle.get(name.toLowerCase());
      if (!section) {
        this.logger.warn(`Biblioteca '${name}' nao encontrada no Plex`);
        continue;
      }
      if (!(section.type === "movie" || section.type === "show")) {
        this.logger.warn(`Biblioteca '${name}' tipo '${section.type}' nao suportada`);
        continue;
      }
      selected.push(section);
    }

    return selected;
  }

  private async syncSingleItem(
    item: PlexMediaItem,
    previousState: SyncItemState | undefined,
    settings: PlexSyncSettings,
    client: SyncClient
  ): Promise<SyncItemResult> {
    const noteRoot = normalizeVaultPath(settings.notesFolder);
    const previousRelPath = previousState?.notePath;
    const { absolutePath, relativePath } = await this.resolveNotePath(item, noteRoot, previousRelPath);

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

    // Regra do modo conta: item assistido deve permanecer na lista para assistir.
    if (obsidianWatched) {
      obsidianWatchlisted = true;
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

    if (!hasPrevious) {
      syncSource = "plex";
    } else if (plexChanged && !obsidianChanged) {
      obsidianWatched = plexCurrentWatched;
      syncSource = "plex";
    } else if (obsidianChanged && !plexChanged) {
      if (obsidianWatched !== plexCurrentWatched) {
        await client.markWatched(item.ratingKey, obsidianWatched);
        plexCurrentWatched = obsidianWatched;
        plexUpdated = true;
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
        await client.markWatched(item.ratingKey, obsidianWatched);
        plexCurrentWatched = obsidianWatched;
        plexUpdated = true;
        syncSource = "obsidian";
      } else {
        obsidianWatched = plexCurrentWatched;
        syncSource = "plex";
      }
    } else if (obsidianChanged && plexChanged && obsidianWatched === plexCurrentWatched) {
      syncSource = "both";
    }

    if (supportsWatchlist) {
      if (!hasPrevious) {
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

      if (plexCurrentWatched && !plexCurrentWatchlisted) {
        await client.setWatchlisted!(item.ratingKey, true);
        plexCurrentWatchlisted = true;
        obsidianWatchlisted = true;
        plexUpdated = true;
        syncSource = mergeSyncSource(syncSource, "obsidian");
      }
    } else {
      obsidianWatchlisted = plexCurrentWatchlisted;
    }

    if (!note.exists) {
      existingBody = defaultBody(item.title);
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

  private async resolveNotePath(
    item: PlexMediaItem,
    noteRoot: string,
    previousRelativePath?: string
  ): Promise<{ absolutePath: string; relativePath: string }> {
    const { relativePath: canonicalRelativePath, absolutePath: canonicalAbsolutePath } =
      await this.resolveCanonicalPath(item, noteRoot);

    if (previousRelativePath) {
      const previousAbsolute = normalizeVaultPath(noteRoot, previousRelativePath);
      const exists = await this.store.fileExists(previousAbsolute);
      if (exists) {
        if (previousRelativePath !== canonicalRelativePath) {
          const canonicalExists = await this.store.fileExists(canonicalAbsolutePath);
          if (!canonicalExists) {
            await this.store.moveAdapterFile(previousAbsolute, canonicalAbsolutePath);
            return {
              absolutePath: canonicalAbsolutePath,
              relativePath: canonicalRelativePath
            };
          }
        }
        return {
          absolutePath: previousAbsolute,
          relativePath: previousRelativePath
        };
      }
    }

    const mappedRelativePath = this.notePathByRatingKey.get(item.ratingKey);
    if (mappedRelativePath) {
      const mappedAbsolute = normalizeVaultPath(noteRoot, mappedRelativePath);
      const exists = await this.store.fileExists(mappedAbsolute);
      if (exists) {
        if (mappedRelativePath !== canonicalRelativePath) {
          const canonicalExists = await this.store.fileExists(canonicalAbsolutePath);
          if (!canonicalExists) {
            await this.store.moveAdapterFile(mappedAbsolute, canonicalAbsolutePath);
            return {
              absolutePath: canonicalAbsolutePath,
              relativePath: canonicalRelativePath
            };
          }
        }
        return {
          absolutePath: mappedAbsolute,
          relativePath: mappedRelativePath
        };
      }
    }

    return {
      absolutePath: canonicalAbsolutePath,
      relativePath: canonicalRelativePath
    };
  }

  private async resolveCanonicalPath(
    item: PlexMediaItem,
    noteRoot: string
  ): Promise<{ absolutePath: string; relativePath: string }> {
    const targetFolder = mediaTypeFolder(item.type);
    const baseName = buildPreferredFileBaseName(item);

    for (let attempt = 0; attempt < 500; attempt += 1) {
      const fileName = buildNumberedFileName(baseName, attempt);
      const relativePath = normalizeVaultPath(targetFolder, fileName);
      const absolutePath = normalizeVaultPath(noteRoot, relativePath);
      const exists = await this.store.fileExists(absolutePath);

      if (!exists) {
        return {
          absolutePath,
          relativePath
        };
      }

      const existingNote = await this.store.readNote(absolutePath);
      const existingRatingKey = existingNote.frontmatter.plex_rating_key;
      if (
        typeof existingRatingKey === "string" &&
        existingRatingKey.trim() === item.ratingKey
      ) {
        return {
          absolutePath,
          relativePath
        };
      }
    }

    const fallbackFileName = `${baseName} - ${item.ratingKey.slice(-6)}.md`;
    const fallbackRelativePath = normalizeVaultPath(targetFolder, fallbackFileName);
    return {
      absolutePath: normalizeVaultPath(noteRoot, fallbackRelativePath),
      relativePath: fallbackRelativePath
    };
  }

  private async resolvePmsTarget(settings: PlexSyncSettings): Promise<ResolvedPmsTarget> {
    const timeoutSeconds = ensureMinNumber(settings.requestTimeoutSeconds, 5);

    if (settings.authMode === "manual") {
      if (!settings.plexBaseUrl.trim() || !settings.plexToken.trim()) {
        throw new Error("configure plexBaseUrl e plexToken nas settings (modo manual)");
      }
      return {
        baseUrl: settings.plexBaseUrl.trim(),
        token: settings.plexToken.trim(),
        serverName: "manual",
        connectionUri: settings.plexBaseUrl.trim()
      };
    }

    if (!settings.plexAccountToken.trim()) {
      throw new Error("modo conta Plex: faca login primeiro (Plex Sync: Login with Plex Account)");
    }

    if (!settings.selectedServerMachineId.trim()) {
      throw new Error("modo conta Plex: selecione um servidor em Settings");
    }

    const server = settings.serversCache.find(
      (entry) => entry.machineId === settings.selectedServerMachineId
    );

    if (!server) {
      throw new Error("servidor selecionado nao encontrado no cache. Rode 'Refresh Plex Servers'");
    }

    const orderedConnections = orderConnections(server.connections, settings.connectionStrategy);
    if (orderedConnections.length === 0) {
      throw new Error("servidor sem conexoes disponiveis para a estrategia selecionada");
    }

    const tokens = tokenCandidates(server.accessToken, settings.plexAccountToken);
    if (tokens.length === 0) {
      throw new Error("token ausente para acessar o servidor selecionado");
    }

    const probeErrors: string[] = [];

    for (const connection of orderedConnections) {
      for (const token of tokens) {
        try {
          const probeClient = new PmsClient(
            {
              baseUrl: connection.uri,
              token,
              timeoutSeconds
            },
            this.logger
          );
          await probeClient.listSections();
          return {
            baseUrl: connection.uri,
            token,
            serverName: server.name,
            machineId: server.machineId,
            connectionUri: connection.uri
          };
        } catch (error) {
          probeErrors.push(`${connection.uri} => ${String(error)}`);
          this.logger.debug("falha probe PMS", {
            connection: connection.uri,
            error: String(error)
          });
        }
      }
    }

    throw new Error(
      `falha ao conectar no servidor '${server.name}' (${server.machineId}). tentativas: ${probeErrors.length}`
    );
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

  private async loadState(path: string): Promise<SyncStateFile> {
    const raw = await this.store.readJson<SyncStateFile>(path);
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
    return {
      acquired: true,
      lockPath
    };
  }

  private async extendLock(settings: PlexSyncSettings, lockPath: string): Promise<void> {
    const ttl = ensureMinNumber(settings.lockTtlSeconds, 30) * 1000;
    const now = Date.now();
    const lock: SyncLockFile = {
      deviceId: this.deviceId,
      acquiredAt: now,
      expiresAt: now + ttl
    };
    await this.store.writeJson(lockPath, lock);
  }

  private async releaseLock(lockPath: string): Promise<void> {
    const current = await this.store.readJson<SyncLockFile>(lockPath);
    if (!current || current.deviceId !== this.deviceId) {
      return;
    }
    await this.store.removeAdapterFile(lockPath);
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

function mediaTypeFolder(type: string): string {
  return type === "show" ? "Series" : "Filmes";
}

function buildPreferredFileBaseName(item: PlexMediaItem): string {
  const sanitizedTitle = sanitizeFileNameSegment(item.title);
  if (typeof item.year === "number" && Number.isFinite(item.year)) {
    const year = Math.floor(item.year);
    if (year >= 1800 && year <= 3000) {
      return `${sanitizedTitle} (${year})`;
    }
  }

  return sanitizedTitle;
}

function sanitizeFileNameSegment(value: string): string {
  const cleaned = (value || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return cleaned.length > 0 ? cleaned : "Item";
}

function buildNumberedFileName(baseName: string, attempt: number): string {
  if (attempt === 0) {
    return `${baseName}.md`;
  }

  return `${baseName} - ${attempt + 1}.md`;
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
