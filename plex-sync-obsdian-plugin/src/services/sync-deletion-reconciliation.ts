import { App } from "obsidian";
import { plexWatched } from "../core/sync-core";
import { normalizeVaultPath, parseBool } from "../core/utils";
import type { PlexMediaItem, SyncReport, SyncStateFile } from "../types";
import { Logger } from "./logger";

interface AccountDeletionClient {
  setWatchlisted(ratingKey: string, watchlisted: boolean): Promise<void>;
  markWatched(ratingKey: string, watched: boolean): Promise<void>;
}

interface PmsDeletionClient {
  markWatched(ratingKey: string, watched: boolean): Promise<void>;
}

interface DeletionContext {
  app: App;
  logger: Logger;
  notePathByRatingKey: Map<string, string>;
  readNoteFrontmatterFast(path: string): Promise<Record<string, unknown>>;
  removeAdapterFile(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
}

interface ListableAdapter {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

export async function syncDeletedAccountItems(params: {
  client: AccountDeletionClient;
  state: SyncStateFile;
  report: SyncReport;
  explicitDeletedRatingKeys?: Set<string>;
  context: Pick<DeletionContext, "logger" | "notePathByRatingKey">;
  emitStatus(text: string): void;
}): Promise<Set<string>> {
  const { client, state, report, explicitDeletedRatingKeys, context, emitStatus } = params;
  const removed = new Set<string>();
  const candidates = findDeletedNoteCandidates(
    state,
    context.notePathByRatingKey,
    explicitDeletedRatingKeys
  );
  if (candidates.length === 0) {
    return removed;
  }

  if (context.notePathByRatingKey.size === 0 && Object.keys(state.items).length > 0) {
    const message =
      "Exclusoes de notas detectadas, mas nenhuma nota Plex foi encontrada no vault atual. Remocao no Plex ignorada para evitar apagamento em massa.";
    context.logger.warn(message);
    report.errors.push(message);
    return removed;
  }

  emitStatus(`Plex Sync: processando ${candidates.length} exclusao(oes) de nota...`);

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
      context.logger.error(message);
      report.errors.push(message);
    }
  }

  return removed;
}

export async function pruneInactiveAccountItems(params: {
  noteRoot: string;
  items: PlexMediaItem[];
  state: SyncStateFile;
  context: DeletionContext;
}): Promise<Set<string>> {
  const { noteRoot, items, state, context } = params;
  const removed = new Set<string>();

  for (const item of items) {
    const watchlisted = parseBool(item.inWatchlist, false);
    const watched = plexWatched(item);
    if (watchlisted || watched) {
      continue;
    }

    const trackedNotePath =
      context.notePathByRatingKey.get(item.ratingKey) || state.items[item.ratingKey]?.notePath;
    const removedAnyNote = await removeAccountItemNotes(
      context,
      noteRoot,
      item.ratingKey,
      trackedNotePath
    );

    if (removedAnyNote || state.items[item.ratingKey]) {
      removed.add(item.ratingKey);
    }
    context.notePathByRatingKey.delete(item.ratingKey);
  }

  return removed;
}

export async function syncDeletedPmsItems(params: {
  pmsClient: PmsDeletionClient;
  state: SyncStateFile;
  report: SyncReport;
  explicitDeletedRatingKeys?: Set<string>;
  accountClient?: AccountDeletionClient;
  context: Pick<DeletionContext, "logger" | "notePathByRatingKey">;
  emitStatus(text: string): void;
}): Promise<Set<string>> {
  const { pmsClient, state, report, explicitDeletedRatingKeys, accountClient, context, emitStatus } =
    params;
  const removed = new Set<string>();
  const candidates = findDeletedNoteCandidates(
    state,
    context.notePathByRatingKey,
    explicitDeletedRatingKeys
  );
  if (candidates.length === 0) {
    return removed;
  }

  if (context.notePathByRatingKey.size === 0 && Object.keys(state.items).length > 0) {
    const message =
      "Exclusoes de notas detectadas, mas nenhuma nota Plex foi encontrada no vault atual. Remocao no Plex ignorada para evitar apagamento em massa.";
    context.logger.warn(message);
    report.errors.push(message);
    return removed;
  }

  emitStatus(`Plex Sync: processando ${candidates.length} exclusao(oes) de nota...`);

  for (const ratingKey of candidates) {
    const failures: string[] = [];
    let changed = false;

    if (accountClient) {
      try {
        await accountClient.setWatchlisted(ratingKey, false);
        changed = true;
      } catch (error) {
        failures.push(`watchlist: ${String(error)}`);
      }

      try {
        await accountClient.markWatched(ratingKey, false);
        changed = true;
      } catch (error) {
        failures.push(`assistido-conta: ${String(error)}`);
      }
    }

    try {
      await pmsClient.markWatched(ratingKey, false);
      changed = true;
    } catch (error) {
      failures.push(`assistido-pms: ${String(error)}`);
    }

    if (changed) {
      removed.add(ratingKey);
      report.updatedPlex += 1;
    } else {
      const message = `Falha ao propagar exclusao da nota ${ratingKey} para o Plex: ${failures.join(" | ")}`;
      context.logger.error(message);
      report.errors.push(message);
    }
  }

  return removed;
}

async function removeAccountItemNotes(
  context: DeletionContext,
  noteRoot: string,
  ratingKey: string,
  trackedRelativePath?: string
): Promise<boolean> {
  const noteRootNormalized = normalizeVaultPath(noteRoot);
  const notePrefix = noteRootNormalized ? `${noteRootNormalized}/` : "";
  const foldersToCleanup = new Set<string>();
  let removedAny = false;

  if (trackedRelativePath) {
    const trackedAbsolutePath = normalizeVaultPath(noteRootNormalized, trackedRelativePath);
    const exists = await context.fileExists(trackedAbsolutePath);
    if (exists) {
      await context.removeAdapterFile(trackedAbsolutePath);
      removedAny = true;
      const parent = getParentFolder(trackedRelativePath);
      if (parent) {
        foldersToCleanup.add(parent);
      }
    }
  }

  for (const file of context.app.vault.getMarkdownFiles()) {
    const filePath = normalizeVaultPath(file.path);
    if (!filePath.startsWith(notePrefix)) {
      continue;
    }

    const noteFrontmatter = await context.readNoteFrontmatterFast(filePath);
    const type = noteFrontmatter.tipo;
    const seriesRatingKey = noteFrontmatter.serie_rating_key;
    if (
      (type === "season" || type === "episode") &&
      typeof seriesRatingKey === "string" &&
      seriesRatingKey === ratingKey
    ) {
      await context.removeAdapterFile(filePath);
      removedAny = true;
      const relativePath = noteRootNormalized
        ? filePath.slice(noteRootNormalized.length + 1)
        : filePath;
      const parent = getParentFolder(relativePath);
      if (parent) {
        foldersToCleanup.add(parent);
      }
    }
  }

  for (const folder of foldersToCleanup) {
    await cleanupEmptyFoldersUnder(context.app.vault.adapter, context.fileExists, noteRootNormalized, folder);
  }

  return removedAny;
}

function findDeletedNoteCandidates(
  state: SyncStateFile,
  notePathByRatingKey: Map<string, string>,
  explicitDeletedRatingKeys?: Set<string>
): string[] {
  const deleted: string[] = [];
  const seen = new Set<string>();

  for (const [ratingKey, itemState] of Object.entries(state.items)) {
    if (!itemState.notePath) {
      continue;
    }
    if (notePathByRatingKey.has(ratingKey)) {
      continue;
    }
    if (seen.has(ratingKey)) {
      continue;
    }
    deleted.push(ratingKey);
    seen.add(ratingKey);
  }

  if (explicitDeletedRatingKeys && explicitDeletedRatingKeys.size > 0) {
    for (const ratingKey of explicitDeletedRatingKeys) {
      if (notePathByRatingKey.has(ratingKey)) {
        continue;
      }
      if (seen.has(ratingKey)) {
        continue;
      }
      deleted.push(ratingKey);
      seen.add(ratingKey);
    }
  }

  return deleted;
}

async function cleanupEmptyFoldersUnder(
  adapter: ListableAdapter,
  fileExists: (path: string) => Promise<boolean>,
  noteRoot: string,
  rootRelative: string
): Promise<boolean> {
  const rootAbsolute = normalizeVaultPath(noteRoot, rootRelative);
  const rootExists = await fileExists(rootAbsolute);
  if (!rootExists) {
    return false;
  }

  const listing = await safeList(adapter, rootAbsolute);
  if (!listing) {
    return false;
  }

  let removedAny = false;
  for (const subfolder of listing.folders) {
    const removed = await removeEmptyFoldersRecursive(adapter, normalizeVaultPath(subfolder));
    if (removed) {
      removedAny = true;
    }
  }

  return removedAny;
}

async function removeEmptyFoldersRecursive(
  adapter: ListableAdapter,
  folderAbsolutePath: string
): Promise<boolean> {
  const listing = await safeList(adapter, folderAbsolutePath);
  if (!listing) {
    return false;
  }

  let removedAny = false;
  for (const subfolder of listing.folders) {
    const removed = await removeEmptyFoldersRecursive(adapter, normalizeVaultPath(subfolder));
    if (removed) {
      removedAny = true;
    }
  }

  const refreshed = await safeList(adapter, folderAbsolutePath);
  if (!refreshed) {
    return removedAny;
  }

  if (refreshed.files.length === 0 && refreshed.folders.length === 0) {
    try {
      await adapter.rmdir(folderAbsolutePath, false);
      return true;
    } catch {
      return removedAny;
    }
  }

  return removedAny;
}

async function safeList(
  adapter: ListableAdapter,
  path: string
): Promise<{ files: string[]; folders: string[] } | undefined> {
  try {
    const listing = await adapter.list(path);
    return {
      files: listing.files,
      folders: listing.folders
    };
  } catch {
    return undefined;
  }
}

function getParentFolder(path: string): string {
  const normalized = normalizeVaultPath(path);
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) {
    return "";
  }
  return normalized.slice(0, idx);
}
