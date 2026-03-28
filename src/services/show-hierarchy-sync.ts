import { App } from "obsidian";
import { MANAGED_KEYS } from "../core/constants";
import { mergeFrontmatter } from "../core/sync-core";
import { normalizeVaultPath, nowIso } from "../core/utils";
import type { NoteData, PlexMediaItem, PlexSeasonInfo } from "../types";
import { Logger } from "./logger";
import { VaultStore } from "./vault-store";

export interface ShowHierarchySyncClient {
  markWatched(ratingKey: string, watched: boolean): Promise<void>;
  supportsSeasonWatchedWrites?: boolean;
  supportsShowWatchedWrites?: boolean;
}

export interface ShowHierarchySyncResult {
  noteChanged: boolean;
  plexUpdated: boolean;
}

interface ShowHierarchySyncParams {
  app: App;
  noteRoot: string;
  showNoteRelativePath: string;
  showItem: PlexMediaItem;
  client: ShowHierarchySyncClient;
  showWatchedOverride?: boolean;
  overrideSeasonRatingKeys?: Set<string>;
  overrideEpisodeRatingKeys?: Set<string>;
  overrideSeasonWatchedByKey?: Map<string, boolean>;
  overrideEpisodeWatchedByKey?: Map<string, boolean>;
  overrideSeasonCheckboxSnapshotsByKey?: Map<string, string>;
  logger: Logger;
  store: VaultStore;
  posterUrlBuilder?: (thumb: string | undefined) => string | undefined;
}

export async function syncShowHierarchy(
  params: ShowHierarchySyncParams
): Promise<ShowHierarchySyncResult> {
  const {
    app,
    noteRoot,
    showNoteRelativePath,
    showItem,
    client,
    showWatchedOverride,
    overrideSeasonRatingKeys,
    overrideEpisodeRatingKeys,
    overrideSeasonWatchedByKey,
    overrideEpisodeWatchedByKey,
    overrideSeasonCheckboxSnapshotsByKey,
    logger,
    store,
    posterUrlBuilder
  } = params;

  const seasons = showItem.seasons || [];
  if (seasons.length === 0) {
    return {
      noteChanged: false,
      plexUpdated: false
    };
  }

  const showFolderRelative = getParentFolder(showNoteRelativePath);
  if (!showFolderRelative) {
    return {
      noteChanged: false,
      plexUpdated: false
    };
  }

  let changed = false;
  let plexUpdated = false;
  const expectedGeneratedFiles = new Set<string>();
  const explicitSeasonTargetCount = overrideSeasonRatingKeys?.size ?? 0;
  const explicitEpisodeTargetCount = overrideEpisodeRatingKeys?.size ?? 0;
  const hasExplicitSeasonTargets = explicitSeasonTargetCount > 0;
  const hasExplicitEpisodeTargets = explicitEpisodeTargetCount > 0;
  const strictWriteRequested =
    typeof showWatchedOverride === "boolean" ||
    hasExplicitSeasonTargets ||
    hasExplicitEpisodeTargets;
  const writeFailures: string[] = [];
  const generatedPathByRatingKey = await scanGeneratedPathsByRatingKey(
    app,
    store,
    noteRoot,
    showFolderRelative,
    showItem.ratingKey
  );

  for (const season of seasons) {
    const forceFromShow = typeof showWatchedOverride === "boolean";
    const seasonContainsTargetEpisode =
      hasExplicitEpisodeTargets &&
      season.episodes.some((episode) => overrideEpisodeRatingKeys?.has(episode.ratingKey) === true);
    const shouldProcessSeason =
      forceFromShow ||
      (!hasExplicitSeasonTargets && !hasExplicitEpisodeTargets) ||
      (hasExplicitSeasonTargets && overrideSeasonRatingKeys?.has(season.ratingKey) === true) ||
      seasonContainsTargetEpisode;
    if (!shouldProcessSeason) {
      continue;
    }
    const existingSeasonRelative = generatedPathByRatingKey.get(season.ratingKey);
    const existingSeasonNote = existingSeasonRelative
      ? await store.readNote(normalizeVaultPath(noteRoot, existingSeasonRelative))
      : emptyNoteData();
    const explicitSeasonCheckboxSnapshot =
      overrideSeasonCheckboxSnapshotsByKey?.get(season.ratingKey);
    const explicitSeasonWatchedOverride = overrideSeasonWatchedByKey?.get(season.ratingKey);
    const seasonWasExplicitlyTargeted =
      !forceFromShow &&
      (overrideSeasonRatingKeys === undefined || overrideSeasonRatingKeys.has(season.ratingKey));
    const checkboxOverrides =
      explicitSeasonCheckboxSnapshot !== undefined
        ? parseSeasonCheckboxSnapshot(explicitSeasonCheckboxSnapshot)
        : seasonWasExplicitlyTargeted && typeof explicitSeasonWatchedOverride !== "boolean"
          ? parseSeasonCheckboxOverrides(existingSeasonNote.body)
          : new Map<string, boolean>();
    // Only apply season-level frontmatter override if this season was explicitly changed by the user.
    const seasonAssistidoWasExplicitlyChanged =
      !forceFromShow &&
      (
        typeof explicitSeasonWatchedOverride === "boolean" ||
        (
          explicitSeasonCheckboxSnapshot === undefined &&
          overrideSeasonRatingKeys !== undefined &&
          overrideSeasonRatingKeys.has(season.ratingKey)
        )
      );
    const seasonAssistidoOverride =
      typeof explicitSeasonWatchedOverride === "boolean"
        ? explicitSeasonWatchedOverride
        : seasonAssistidoWasExplicitlyChanged
          ? parseOptionalBool(existingSeasonNote.frontmatter.assistido)
          : undefined;
    const episodeDesiredWatched = new Map<string, boolean>();

    for (const episode of season.episodes) {
      episodeDesiredWatched.set(episode.ratingKey, episode.watched);

      const desiredByExplicitEpisodeOverride = overrideEpisodeWatchedByKey?.get(episode.ratingKey);
      if (typeof desiredByExplicitEpisodeOverride === "boolean") {
        episodeDesiredWatched.set(episode.ratingKey, desiredByExplicitEpisodeOverride);
      }

      const desiredByCheckbox = checkboxOverrides.get(episode.ratingKey);
      if (typeof desiredByCheckbox === "boolean") {
        episodeDesiredWatched.set(episode.ratingKey, desiredByCheckbox);
      }

      // Only read episode note when: full/manual sync (no season targeting), or this episode was explicitly changed
      if (
        !forceFromShow &&
        typeof desiredByExplicitEpisodeOverride !== "boolean" &&
        (overrideSeasonRatingKeys === undefined || overrideEpisodeRatingKeys?.has(episode.ratingKey) === true)
      ) {
        const existingEpisodeRelative = generatedPathByRatingKey.get(episode.ratingKey);
        const existingEpisode = existingEpisodeRelative
          ? await store.readNote(normalizeVaultPath(noteRoot, existingEpisodeRelative))
          : emptyNoteData();
        const desiredByEpisodeFrontmatter = parseOptionalBool(existingEpisode.frontmatter.assistido);
        if (typeof desiredByEpisodeFrontmatter === "boolean") {
          episodeDesiredWatched.set(episode.ratingKey, desiredByEpisodeFrontmatter);
        }
      }
    }

    if (forceFromShow) {
      for (const episode of season.episodes) {
        episodeDesiredWatched.set(episode.ratingKey, showWatchedOverride);
      }
    }

    const watchedFromPlex = countWatchedEpisodes(season);
    const totalEpisodesInSeason =
      typeof season.episodeCount === "number" ? season.episodeCount : season.episodes.length;
    const seasonWatchedFromPlex =
      totalEpisodesInSeason > 0 ? watchedFromPlex >= totalEpisodesInSeason : false;
    if (typeof seasonAssistidoOverride === "boolean") {
      for (const episode of season.episodes) {
        episodeDesiredWatched.set(episode.ratingKey, seasonAssistidoOverride);
      }
    }

    if (forceFromShow) {
      const canWriteShowDirectly = client.supportsShowWatchedWrites !== false;
      if (canWriteShowDirectly) {
        for (const episode of season.episodes) {
          episode.watched = showWatchedOverride;
        }
      } else {
        const pendingEpisodeUpdates = season.episodes
          .map((episode) => {
            const desiredWatched = episodeDesiredWatched.get(episode.ratingKey);
            if (typeof desiredWatched !== "boolean" || desiredWatched === episode.watched) {
              return undefined;
            }
            return { episode, desiredWatched };
          })
          .filter(
            (entry): entry is { episode: PlexSeasonInfo["episodes"][number]; desiredWatched: boolean } =>
              entry !== undefined
          );

        await Promise.all(
          pendingEpisodeUpdates.map(async ({ episode, desiredWatched }) => {
            try {
              await client.markWatched(episode.ratingKey, desiredWatched);
              episode.watched = desiredWatched;
              plexUpdated = true;
            } catch (error) {
              writeFailures.push(
                `episodio ${episode.ratingKey} -> ${String(error)}`
              );
              logger.debug("falha ao aplicar assistido da serie via episodio no Plex", {
                ratingKey: episode.ratingKey,
                desiredWatched,
                error: String(error)
              });
            }
          })
        );
      }
    } else if (typeof seasonAssistidoOverride === "boolean") {
      const canWriteSeasonDirectly = client.supportsSeasonWatchedWrites !== false;
      if (canWriteSeasonDirectly && seasonAssistidoOverride !== seasonWatchedFromPlex) {
        try {
          await client.markWatched(season.ratingKey, seasonAssistidoOverride);
          plexUpdated = true;
        } catch (error) {
          writeFailures.push(
            `temporada ${season.ratingKey} -> ${String(error)}`
          );
          logger.debug("falha ao aplicar assistido da temporada no Plex", {
            ratingKey: season.ratingKey,
            desiredWatched: seasonAssistidoOverride,
            error: String(error)
          });
        }
      } else if (!canWriteSeasonDirectly) {
        const pendingEpisodeUpdates = season.episodes
          .map((episode) => {
            const desiredWatched = episodeDesiredWatched.get(episode.ratingKey);
            if (typeof desiredWatched !== "boolean" || desiredWatched === episode.watched) {
              return undefined;
            }
            return { episode, desiredWatched };
          })
          .filter(
            (entry): entry is { episode: PlexSeasonInfo["episodes"][number]; desiredWatched: boolean } =>
              entry !== undefined
          );

        await Promise.all(
          pendingEpisodeUpdates.map(async ({ episode, desiredWatched }) => {
            try {
              await client.markWatched(episode.ratingKey, desiredWatched);
              episode.watched = desiredWatched;
              plexUpdated = true;
            } catch (error) {
              writeFailures.push(
                `episodio ${episode.ratingKey} -> ${String(error)}`
              );
              logger.debug("falha ao aplicar fallback episodio-a-episodio da temporada no Plex", {
                ratingKey: episode.ratingKey,
                desiredWatched,
                error: String(error)
              });
            }
          })
        );
      }

      for (const episode of season.episodes) {
        episode.watched = seasonAssistidoOverride;
      }
    } else {
      const pendingEpisodeUpdates = season.episodes
        .map((episode) => {
          const desiredWatched = episodeDesiredWatched.get(episode.ratingKey);
          if (typeof desiredWatched !== "boolean" || desiredWatched === episode.watched) {
            return undefined;
          }
          return { episode, desiredWatched };
        })
        .filter(
          (entry): entry is { episode: PlexSeasonInfo["episodes"][number]; desiredWatched: boolean } =>
            entry !== undefined
        );

      await Promise.all(
        pendingEpisodeUpdates.map(async ({ episode, desiredWatched }) => {
          try {
            await client.markWatched(episode.ratingKey, desiredWatched);
            episode.watched = desiredWatched;
            plexUpdated = true;
          } catch (error) {
            writeFailures.push(
              `episodio ${episode.ratingKey} -> ${String(error)}`
            );
            logger.debug("falha ao aplicar checkbox/frontmatter da temporada no Plex", {
              ratingKey: episode.ratingKey,
              desiredWatched,
              error: String(error)
            });
          }
        })
      );
    }

    if (forceFromShow && writeFailures.length > 0) {
      throw new Error(writeFailures.join(" | "));
    }

    if (strictWriteRequested && !plexUpdated && writeFailures.length > 0) {
      throw new Error(writeFailures.join(" | "));
    }

    season.watchedEpisodeCount = countWatchedEpisodes(season);

    const watchedEpisodes = countWatchedEpisodes(season);
    const totalEpisodes =
      typeof season.episodeCount === "number" ? season.episodeCount : season.episodes.length;
    const seasonWatched = totalEpisodes > 0 ? watchedEpisodes >= totalEpisodes : false;

    const seasonFolderName = buildSeasonFolderName(season);
    const seasonFolderRelative = normalizeVaultPath(showFolderRelative, seasonFolderName);
    const seasonNoteRelative = normalizeVaultPath(
      seasonFolderRelative,
      `${buildSeasonNoteFileName(seasonFolderName)}.md`
    );
    expectedGeneratedFiles.add(seasonNoteRelative);

    if (existingSeasonRelative) {
      const existingSeasonFolderRelative = getParentFolder(existingSeasonRelative);
      if (
        existingSeasonFolderRelative &&
        existingSeasonFolderRelative !== seasonFolderRelative
      ) {
        const movedFolder = await moveGeneratedPath(
          store,
          noteRoot,
          existingSeasonFolderRelative,
          seasonFolderRelative
        );
        if (movedFolder) {
          changed = true;
          rebaseGeneratedPathsForFolder(
            generatedPathByRatingKey,
            existingSeasonFolderRelative,
            seasonFolderRelative
          );
        }
      }
    }

    const currentSeasonRelative = generatedPathByRatingKey.get(season.ratingKey);
    if (currentSeasonRelative && currentSeasonRelative !== seasonNoteRelative) {
      const movedSeasonNote = await moveGeneratedPath(
        store,
        noteRoot,
        currentSeasonRelative,
        seasonNoteRelative
      );
      if (movedSeasonNote) {
        changed = true;
      }
    }
    generatedPathByRatingKey.set(season.ratingKey, seasonNoteRelative);

    for (const episode of season.episodes) {
      const episodeFileBase = buildEpisodeFileBaseName(episode);
      const episodeRelative = normalizeVaultPath(seasonFolderRelative, `${episodeFileBase}.md`);
      expectedGeneratedFiles.add(episodeRelative);

      const existingEpisodeRelative = generatedPathByRatingKey.get(episode.ratingKey);
      if (existingEpisodeRelative && existingEpisodeRelative !== episodeRelative) {
        const movedEpisode = await moveGeneratedPath(
          store,
          noteRoot,
          existingEpisodeRelative,
          episodeRelative
        );
        if (movedEpisode) {
          changed = true;
        }
      }
      generatedPathByRatingKey.set(episode.ratingKey, episodeRelative);
      const shouldRenderEpisodeNote =
        forceFromShow ||
        hasExplicitSeasonTargets ||
        !hasExplicitEpisodeTargets ||
        overrideEpisodeRatingKeys?.has(episode.ratingKey) === true;
      if (!shouldRenderEpisodeNote) {
        continue;
      }
      const refreshedEpisodeNote = await store.readNote(
        normalizeVaultPath(noteRoot, episodeRelative)
      );

      const episodeRendered = await renderManagedHierarchyNote(
        store,
        noteRoot,
        episodeRelative,
        {
          plex_rating_key: episode.ratingKey,
          plex_parent_rating_key: season.ratingKey,
          biblioteca: showItem.libraryTitle,
          tipo: "episode",
          titulo: episode.title,
          serie_titulo: showItem.title,
          serie_rating_key: showItem.ratingKey,
          ano: showItem.year,
          temporada_numero: episode.seasonNumber ?? season.seasonNumber,
          episodio_numero: episode.episodeNumber,
          resumo: episode.summary,
          duracao_minutos: episode.durationMs
            ? Math.round(episode.durationMs / 60000)
            : undefined,
          pausa: normalizePauseSeed(refreshedEpisodeNote.frontmatter.pausa),
          assistido: episode.watched
        },
        defaultEpisodeBody(showItem.title, seasonFolderName, episode)
      );
      if (episodeRendered) {
        changed = true;
      }
    }

    const refreshedSeasonNote = await store.readNote(normalizeVaultPath(noteRoot, seasonNoteRelative));
    const seasonBodySeed = refreshedSeasonNote.exists
      ? refreshedSeasonNote.body
      : defaultSeasonBody(showItem.title, seasonFolderName, posterUrlBuilder?.(season.thumb));
    const seasonBody = applyManagedSeasonEpisodesSection(
      seasonBodySeed,
      season,
      seasonFolderRelative
    );
    const seasonRendered = await renderManagedHierarchyNote(
      store,
      noteRoot,
      seasonNoteRelative,
      {
        plex_rating_key: season.ratingKey,
        plex_parent_rating_key: showItem.ratingKey,
        biblioteca: showItem.libraryTitle,
        tipo: "season",
        titulo: season.title,
        serie_titulo: showItem.title,
        serie_rating_key: showItem.ratingKey,
        ano: showItem.year,
        temporada_numero: season.seasonNumber,
        resumo: season.summary,
        nota_critica: season.rating,
        nota_critica_fonte: season.ratingImage,
        nota_publico: season.audienceRating,
        nota_publico_fonte: season.audienceRatingImage,
        capa_url: season.thumb,
        fundo_url: season.art,
        episodios: totalEpisodes,
        episodios_assistidos: watchedEpisodes,
        assistido: seasonWatched
      },
      seasonBody
    );
    if (seasonRendered) {
      changed = true;
    }
  }

  const shouldCleanupGeneratedNotes = !strictWriteRequested;
  const cleaned = shouldCleanupGeneratedNotes
    ? await cleanupGeneratedShowNotes(
        app,
        store,
        noteRoot,
        showFolderRelative,
        showItem.ratingKey,
        expectedGeneratedFiles
      )
    : false;
  const cleanedFolders = shouldCleanupGeneratedNotes
    ? await cleanupEmptyFoldersUnder(app, store, noteRoot, showFolderRelative)
    : false;
  return {
    noteChanged: changed || cleaned || cleanedFolders,
    plexUpdated
  };
}

async function scanGeneratedPathsByRatingKey(
  app: App,
  store: VaultStore,
  noteRoot: string,
  showFolderRelative: string,
  showRatingKey: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const noteRootNormalized = normalizeVaultPath(noteRoot);
  const folderPrefix = `${normalizeVaultPath(noteRootNormalized, showFolderRelative)}/`;

  for (const file of app.vault.getMarkdownFiles()) {
    const filePath = normalizeVaultPath(file.path);
    if (!filePath.startsWith(folderPrefix)) {
      continue;
    }
    const note = await store.readNote(filePath);
    const type = note.frontmatter.tipo;
    const ratingKey = note.frontmatter.plex_rating_key;
    const seriesRatingKey = note.frontmatter.serie_rating_key;
    if (
      (type === "season" || type === "episode") &&
      typeof ratingKey === "string" &&
      typeof seriesRatingKey === "string" &&
      seriesRatingKey === showRatingKey
    ) {
      const relativePath = noteRootNormalized
        ? filePath.slice(noteRootNormalized.length + 1)
        : filePath;
      result.set(ratingKey, relativePath);
    }
  }

  return result;
}

async function moveGeneratedPath(
  store: VaultStore,
  noteRoot: string,
  fromRelativePath: string,
  toRelativePath: string
): Promise<boolean> {
  if (fromRelativePath === toRelativePath) {
    return false;
  }

  const fromAbsolute = normalizeVaultPath(noteRoot, fromRelativePath);
  const toAbsolute = normalizeVaultPath(noteRoot, toRelativePath);
  const fromExists = await store.fileExists(fromAbsolute);
  if (!fromExists) {
    return false;
  }
  const toExists = await store.fileExists(toAbsolute);
  if (toExists) {
    return false;
  }

  await store.moveAdapterFile(fromAbsolute, toAbsolute);
  return true;
}

function rebaseGeneratedPathsForFolder(
  mapping: Map<string, string>,
  oldFolderRelative: string,
  newFolderRelative: string
): void {
  const oldPrefix = `${normalizeVaultPath(oldFolderRelative)}/`;
  const newPrefix = `${normalizeVaultPath(newFolderRelative)}/`;

  for (const [ratingKey, relativePath] of mapping.entries()) {
    const normalized = normalizeVaultPath(relativePath);
    if (normalized === normalizeVaultPath(oldFolderRelative)) {
      mapping.set(ratingKey, normalizeVaultPath(newFolderRelative));
      continue;
    }
    if (normalized.startsWith(oldPrefix)) {
      mapping.set(ratingKey, normalizeVaultPath(newPrefix, normalized.slice(oldPrefix.length)));
    }
  }
}

async function cleanupEmptyFoldersUnder(
  app: App,
  store: VaultStore,
  noteRoot: string,
  rootRelative: string
): Promise<boolean> {
  const rootAbsolute = normalizeVaultPath(noteRoot, rootRelative);
  const rootExists = await store.fileExists(rootAbsolute);
  if (!rootExists) {
    return false;
  }

  const listing = await safeList(app, rootAbsolute);
  if (!listing) {
    return false;
  }

  let removedAny = false;
  for (const subfolder of listing.folders) {
    const removed = await removeEmptyFoldersRecursive(app, normalizeVaultPath(subfolder));
    if (removed) {
      removedAny = true;
    }
  }

  return removedAny;
}

async function removeEmptyFoldersRecursive(
  app: App,
  folderAbsolutePath: string
): Promise<boolean> {
  const listing = await safeList(app, folderAbsolutePath);
  if (!listing) {
    return false;
  }

  let removedAny = false;
  for (const subfolder of listing.folders) {
    const removed = await removeEmptyFoldersRecursive(app, normalizeVaultPath(subfolder));
    if (removed) {
      removedAny = true;
    }
  }

  const refreshed = await safeList(app, folderAbsolutePath);
  if (!refreshed) {
    return removedAny;
  }

  if (refreshed.files.length === 0 && refreshed.folders.length === 0) {
    try {
      await app.vault.adapter.rmdir(folderAbsolutePath, false);
      return true;
    } catch {
      return removedAny;
    }
  }

  return removedAny;
}

async function safeList(
  app: App,
  path: string
): Promise<{ files: string[]; folders: string[] } | undefined> {
  try {
    const listing = await app.vault.adapter.list(path);
    return {
      files: listing.files,
      folders: listing.folders
    };
  } catch {
    return undefined;
  }
}

async function renderManagedHierarchyNote(
  store: VaultStore,
  noteRoot: string,
  relativePath: string,
  managedFrontmatter: Record<string, unknown>,
  initialBody: string
): Promise<boolean> {
  const absolutePath = normalizeVaultPath(noteRoot, relativePath);
  const note = await store.readNote(absolutePath);
  const managedSeed = { ...managedFrontmatter };
  if (!note.exists) {
    managedSeed.sincronizado_em = nowIso();
    managedSeed.sincronizado_por = "plex";
  } else {
    const existingSyncedAt = asNonEmptyString(note.frontmatter.sincronizado_em);
    const existingSyncedBy = asNonEmptyString(note.frontmatter.sincronizado_por);
    if (existingSyncedAt) {
      managedSeed.sincronizado_em = existingSyncedAt;
    }
    if (existingSyncedBy) {
      managedSeed.sincronizado_por = existingSyncedBy;
    }
  }
  managedSeed.minha_nota = typeof note.frontmatter.minha_nota === "number" ? note.frontmatter.minha_nota : "";

  const mergedFrontmatter = mergeFrontmatter(
    note.frontmatter,
    managedSeed as never
  );
  applyNonManagedSeedFrontmatter(mergedFrontmatter, managedSeed);
  const body = note.exists ? note.body : initialBody;
  const rendered = store.renderMarkdown(mergedFrontmatter, body);
  if (note.exists && rendered === note.content) {
    return false;
  }
  await store.writeNote(absolutePath, rendered);
  return true;
}

function applyNonManagedSeedFrontmatter(
  mergedFrontmatter: Record<string, unknown>,
  managedFrontmatter: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(managedFrontmatter)) {
    if (MANAGED_KEYS.includes(key as (typeof MANAGED_KEYS)[number])) {
      continue;
    }
    if (key in mergedFrontmatter) {
      continue;
    }
    if (value === undefined || value === null || value === "") {
      continue;
    }
    mergedFrontmatter[key] = value;
  }
}

async function cleanupGeneratedShowNotes(
  app: App,
  store: VaultStore,
  noteRoot: string,
  showFolderRelative: string,
  showRatingKey: string,
  expectedFiles: Set<string>
): Promise<boolean> {
  const noteRootNormalized = normalizeVaultPath(noteRoot);
  const folderPrefix = `${normalizeVaultPath(noteRootNormalized, showFolderRelative)}/`;
  let removedAny = false;

  for (const file of app.vault.getMarkdownFiles()) {
    const filePath = normalizeVaultPath(file.path);
    if (!filePath.startsWith(folderPrefix)) {
      continue;
    }

    const relativePath = noteRootNormalized
      ? filePath.slice(noteRootNormalized.length + 1)
      : filePath;
    if (expectedFiles.has(relativePath)) {
      continue;
    }

    const note = await store.readNote(filePath);
    const type = note.frontmatter.tipo;
    const seriesRatingKey = note.frontmatter.serie_rating_key;
    if (
      (type === "season" || type === "episode") &&
      typeof seriesRatingKey === "string" &&
      seriesRatingKey === showRatingKey
    ) {
      await store.removeAdapterFile(filePath);
      removedAny = true;
    }
  }

  return removedAny;
}

function sanitizeFileNameSegment(value: string): string {
  const cleaned = (value || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return cleaned.length > 0 ? cleaned : "Item";
}

function getParentFolder(path: string): string {
  const normalized = normalizeVaultPath(path);
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) {
    return "";
  }
  return normalized.slice(0, idx);
}

function buildSeasonFolderName(season: PlexSeasonInfo): string {
  if (typeof season.seasonNumber === "number") {
    return `Temporada ${season.seasonNumber}`;
  }
  return sanitizeFileNameSegment(season.title || "Temporada");
}

function buildSeasonNoteFileName(seasonFolderName: string): string {
  if (seasonFolderName.startsWith("- ")) {
    return seasonFolderName;
  }
  return `- ${seasonFolderName}`;
}

function countWatchedEpisodes(season: PlexSeasonInfo): number {
  if (Array.isArray(season.episodes) && season.episodes.length > 0) {
    return season.episodes.filter((entry) => entry.watched).length;
  }
  return typeof season.watchedEpisodeCount === "number" ? season.watchedEpisodeCount : 0;
}

function buildEpisodeFileBaseName(episode: PlexSeasonInfo["episodes"][number]): string {
  const sanitizedTitle = sanitizeFileNameSegment(episode.title);
  if (typeof episode.episodeNumber === "number") {
    const episodeLabel = buildEpisodeNumberLabel(episode.episodeNumber);
    return `${episodeLabel} - ${sanitizedTitle}`;
  }

  return sanitizedTitle;
}

function defaultSeasonBody(showTitle: string, seasonLabel: string, posterUrl?: string): string {
  const poster = posterUrl ? `![](${posterUrl})\n\n` : "";
  return `${poster}# ${showTitle} - ${seasonLabel}\n\nNota sincronizada automaticamente com Plex.\n`;
}

function defaultEpisodeBody(
  showTitle: string,
  seasonLabel: string,
  episode: PlexSeasonInfo["episodes"][number]
): string {
  const label =
    typeof episode.episodeNumber === "number"
      ? `${buildEpisodeNumberLabel(episode.episodeNumber)} - ${episode.title}`
      : episode.title;
  return `# ${label}\n\nSérie: ${showTitle}\nTemporada: ${seasonLabel}\n\nNota sincronizada automaticamente com Plex.\n`;
}

function applyManagedSeasonEpisodesSection(
  body: string,
  season: PlexSeasonInfo,
  seasonFolderRelative: string
): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const withoutSection = normalized
    .replace(
      /<!-- plex-season-episodes:start -->[\s\S]*?<!-- plex-season-episodes:end -->\n?/g,
      ""
    )
    .trimEnd();

  const section = renderSeasonEpisodesSection(season, seasonFolderRelative);
  const prefix = withoutSection.length > 0 ? `${withoutSection}\n\n` : "";
  return `${prefix}${section}\n`;
}

function renderSeasonEpisodesSection(season: PlexSeasonInfo, seasonFolderRelative: string): string {
  const episodes = [...season.episodes].sort((a, b) => {
    const aNum = typeof a.episodeNumber === "number" ? a.episodeNumber : Number.MAX_SAFE_INTEGER;
    const bNum = typeof b.episodeNumber === "number" ? b.episodeNumber : Number.MAX_SAFE_INTEGER;
    if (aNum !== bNum) {
      return aNum - bNum;
    }
    return a.title.localeCompare(b.title);
  });

  const lines: string[] = ["<!-- plex-season-episodes:start -->", "## Episodios", ""];
  for (const episode of episodes) {
    const check = episode.watched ? "x" : " ";
    const targetFile = buildEpisodeFileBaseName(episode);
    const target = normalizeVaultPath(seasonFolderRelative, targetFile);
    const label = buildEpisodeDisplayLabel(episode);
    lines.push(
      `- [${check}] [[${target}|${label}]] <!-- plex_episode_rating_key:${episode.ratingKey} -->`
    );
  }
  lines.push("<!-- plex-season-episodes:end -->");
  return lines.join("\n");
}

function buildEpisodeDisplayLabel(episode: PlexSeasonInfo["episodes"][number]): string {
  if (typeof episode.episodeNumber === "number") {
    const number = buildEpisodeNumberLabel(episode.episodeNumber);
    return `${number} - ${episode.title}`;
  }
  return episode.title;
}

function buildEpisodeNumberLabel(episodeNumber: number): string {
  return String(Math.floor(episodeNumber)).padStart(2, "0");
}

function normalizePauseSeed(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return formatAsMinuteSecond(Math.floor(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return "";
    }
    if (trimmed === "--:--") {
      return "";
    }
    const normalized = normalizePauseString(trimmed);
    if (normalized) {
      return normalized;
    }
    return trimmed;
  }
  return "";
}

function normalizePauseString(raw: string): string | undefined {
  if (/^\d+$/.test(raw)) {
    if (raw.length >= 3) {
      const seconds = Number(raw.slice(-2));
      const minutes = Number(raw.slice(0, -2));
      if (Number.isFinite(seconds) && Number.isFinite(minutes) && seconds < 60) {
        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      }
    }
    const asSeconds = Number(raw);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return formatAsMinuteSecond(Math.floor(asSeconds));
    }
    return undefined;
  }

  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    const [minutesRaw, secondsRaw] = raw.split(":");
    const minutes = Number(minutesRaw);
    const seconds = Number(secondsRaw);
    if (Number.isFinite(minutes) && Number.isFinite(seconds) && seconds < 60) {
      return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return undefined;
  }

  return undefined;
}

function formatAsMinuteSecond(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseSeasonCheckboxOverrides(body: string): Map<string, boolean> {
  const overrides = new Map<string, boolean>();
  const normalized = body.replace(/\r\n/g, "\n");
  const sectionMatch = normalized.match(
    /<!-- plex-season-episodes:start -->[\s\S]*?<!-- plex-season-episodes:end -->/
  );
  if (!sectionMatch) {
    return overrides;
  }

  const lineRegex =
    /^\s*-\s*\[( |x|X)\][^\n]*<!--\s*plex_episode_rating_key:\s*([^\s>]+)\s*-->\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(sectionMatch[0])) !== null) {
    const checked = match[1].toLowerCase() === "x";
    const ratingKey = match[2];
    overrides.set(ratingKey, checked);
  }

  return overrides;
}

function parseSeasonCheckboxSnapshot(snapshot: string): Map<string, boolean> {
  const overrides = new Map<string, boolean>();
  const normalized = snapshot.trim();
  if (normalized.length === 0) {
    return overrides;
  }

  for (const pair of normalized.split(",")) {
    const separatorIndex = pair.lastIndexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const ratingKey = pair.slice(0, separatorIndex).trim();
    const rawValue = pair.slice(separatorIndex + 1).trim();
    if (!ratingKey || (rawValue !== "0" && rawValue !== "1")) {
      continue;
    }
    overrides.set(ratingKey, rawValue === "1");
  }

  return overrides;
}

function parseOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "sim", "s"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", "nao"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function emptyNoteData(): NoteData {
  return {
    exists: false,
    path: "",
    content: "",
    body: "",
    frontmatter: {},
    mtimeMs: 0
  };
}
