import { plexWatched } from "../core/sync-core";
import { parseBool } from "../core/utils";
import type { PlexMediaItem, SyncItemState, SyncStateFile } from "../types";
import { Logger } from "./logger";

interface AccountItemClient {
  listWatchlist(): Promise<PlexMediaItem[]>;
  listWatchedHistory(sinceViewedAt?: number): Promise<PlexMediaItem[]>;
  getTrackedItem(ratingKey: string): Promise<PlexMediaItem | undefined>;
}

export async function fetchAccountItems(params: {
  client: AccountItemClient;
  state: SyncStateFile;
  noteTrackedKeys: string[];
  excludedKeys: Set<string>;
  trackedLookupLimit: number;
  logger: Logger;
}): Promise<PlexMediaItem[]> {
  const { client, state, noteTrackedKeys, excludedKeys, trackedLookupLimit, logger } = params;
  const watchlistItems = await client.listWatchlist();
  const lastKnownViewedAt = computeLastKnownViewedAt(state);
  const watchedHistoryItems = await client.listWatchedHistory(lastKnownViewedAt);
  const dedup = new Map<string, PlexMediaItem>(
    watchlistItems
      .filter((item) => !excludedKeys.has(item.ratingKey))
      .map((item) => [item.ratingKey, item])
  );

  for (const item of watchedHistoryItems) {
    if (excludedKeys.has(item.ratingKey)) {
      continue;
    }
    if (!dedup.has(item.ratingKey)) {
      dedup.set(item.ratingKey, item);
    }
  }

  const trackedKeys = Array.from(
    new Set<string>(
      [...Object.keys(state.items), ...noteTrackedKeys].filter((ratingKey) => !excludedKeys.has(ratingKey))
    )
  ).filter((ratingKey) => !dedup.has(ratingKey));

  const cappedTrackedKeys =
    trackedLookupLimit > 0 ? trackedKeys.slice(0, trackedLookupLimit) : [];

  await loadTrackedAccountItemsConcurrently(client, cappedTrackedKeys, dedup, logger);

  return Array.from(dedup.values());
}

export async function fetchTargetAccountItems(params: {
  client: AccountItemClient;
  ratingKeys: string[];
  excludedKeys: Set<string>;
  logger: Logger;
}): Promise<PlexMediaItem[]> {
  const { client, ratingKeys, excludedKeys, logger } = params;
  const cleaned = Array.from(
    new Set<string>(
      ratingKeys
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && !excludedKeys.has(entry))
    )
  );
  if (cleaned.length === 0) {
    return [];
  }

  const dedup = new Map<string, PlexMediaItem>();
  await loadTrackedAccountItemsConcurrently(client, cleaned, dedup, logger);
  return cleaned
    .map((ratingKey) => dedup.get(ratingKey))
    .filter((item): item is PlexMediaItem => Boolean(item));
}

export async function enrichAccountItemForSync(params: {
  client: AccountItemClient;
  item: PlexMediaItem;
  logger: Logger;
}): Promise<PlexMediaItem> {
  const { client, item, logger } = params;
  try {
    const detailed = await client.getTrackedItem(item.ratingKey);
    if (detailed) {
      return detailed;
    }
  } catch (error) {
    logger.debug("falha ao enriquecer item da conta para sync", {
      ratingKey: item.ratingKey,
      error: String(error)
    });
  }
  return item;
}

export function shouldProcessIncrementally(params: {
  item: PlexMediaItem;
  previousState: SyncItemState | undefined;
  currentNotePath: string | undefined;
  forceTargetedSync: boolean;
  preferObsidianWhenStateMissing: boolean;
  preferredObsidianWatched: boolean | undefined;
  forceFullRebuild: boolean;
  observedObsidianWatched: boolean | undefined;
  observedObsidianWatchlisted: boolean | undefined;
}): boolean {
  const {
    item,
    previousState,
    currentNotePath,
    forceTargetedSync,
    preferObsidianWhenStateMissing,
    preferredObsidianWatched,
    forceFullRebuild,
    observedObsidianWatched,
    observedObsidianWatchlisted
  } = params;

  if (forceFullRebuild) {
    return true;
  }

  if (forceTargetedSync) {
    return true;
  }

  if (!previousState) {
    return true;
  }

  if (preferObsidianWhenStateMissing || typeof preferredObsidianWatched === "boolean") {
    return true;
  }

  if (!currentNotePath) {
    return true;
  }

  if (previousState.notePath && previousState.notePath !== currentNotePath) {
    return true;
  }

  const currentPlexWatched = plexWatched(item);
  const prevPlexWatched = parseBool(previousState.plexWatched, currentPlexWatched);
  if (currentPlexWatched !== prevPlexWatched) {
    return true;
  }

  if (typeof item.inWatchlist === "boolean") {
    const prevPlexWatchlisted = parseBool(previousState.plexWatchlisted, item.inWatchlist);
    if (item.inWatchlist !== prevPlexWatchlisted) {
      return true;
    }
  }

  if (typeof observedObsidianWatched === "boolean") {
    const prevObsidianWatched = parseBool(previousState.obsidianWatched, observedObsidianWatched);
    if (observedObsidianWatched !== prevObsidianWatched) {
      return true;
    }
  }

  if (typeof observedObsidianWatchlisted === "boolean") {
    const prevObsidianWatchlisted = parseBool(
      previousState.obsidianWatchlisted,
      observedObsidianWatchlisted
    );
    if (observedObsidianWatchlisted !== prevObsidianWatchlisted) {
      return true;
    }
  }

  if (typeof item.updatedAt === "number") {
    if (
      typeof previousState.plexUpdatedAt !== "number" ||
      previousState.plexUpdatedAt !== item.updatedAt
    ) {
      return true;
    }
  }

  if (typeof item.lastViewedAt === "number") {
    if (
      typeof previousState.plexLastViewedAt !== "number" ||
      previousState.plexLastViewedAt !== item.lastViewedAt
    ) {
      return true;
    }
  }

  return false;
}

async function loadTrackedAccountItemsConcurrently(
  client: AccountItemClient,
  ratingKeys: string[],
  dedup: Map<string, PlexMediaItem>,
  logger: Logger
): Promise<void> {
  if (ratingKeys.length === 0) {
    return;
  }

  const concurrency = Math.min(8, ratingKeys.length);
  let index = 0;

  const workers = Array.from({ length: concurrency }).map(async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= ratingKeys.length) {
        break;
      }
      const ratingKey = ratingKeys[current];
      try {
        const tracked = await client.getTrackedItem(ratingKey);
        if (tracked) {
          dedup.set(ratingKey, tracked);
        }
      } catch (error) {
        logger.debug("falha ao carregar item rastreado da conta", {
          ratingKey,
          error: String(error)
        });
      }
    }
  });

  await Promise.all(workers);
}

function computeLastKnownViewedAt(state: SyncStateFile): number | undefined {
  let max = 0;
  for (const item of Object.values(state.items)) {
    if (typeof item.plexLastViewedAt === "number" && item.plexLastViewedAt > max) {
      max = item.plexLastViewedAt;
    }
  }
  return max > 0 ? max : undefined;
}
