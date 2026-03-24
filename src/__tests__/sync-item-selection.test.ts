import { describe, expect, it } from "vitest";
import { shouldProcessIncrementally } from "../services/sync-item-selection";
import type { PlexMediaItem, SyncItemState } from "../types";

function buildItem(overrides: Partial<PlexMediaItem> = {}): PlexMediaItem {
  return {
    ratingKey: "show-1",
    type: "show",
    title: "Severance",
    libraryTitle: "Series",
    updatedAt: 1700000000,
    lastViewedAt: 1700000001,
    leafCount: 10,
    viewedLeafCount: 2,
    ...overrides
  };
}

function buildState(overrides: Partial<SyncItemState> = {}): SyncItemState {
  return {
    notePath: "Series/Severance (2022)/Severance (2022).md",
    plexWatched: false,
    obsidianWatched: false,
    plexWatchlisted: false,
    obsidianWatchlisted: false,
    plexUpdatedAt: 1700000000,
    plexLastViewedAt: 1700000001,
    lastSyncAt: "2026-03-23T00:00:00.000Z",
    lastSyncEpoch: 1700000001000,
    ...overrides
  };
}

describe("sync-item-selection", () => {
  it("processa itens explicitamente alvo mesmo sem mudancas incrementais", () => {
    const shouldProcess = shouldProcessIncrementally({
      item: buildItem(),
      previousState: buildState(),
      currentNotePath: "Series/Severance (2022)/Severance (2022).md",
      forceTargetedSync: true,
      preferObsidianWhenStateMissing: false,
      preferredObsidianWatched: undefined,
      forceFullRebuild: false,
      observedObsidianWatched: undefined,
      observedObsidianWatchlisted: undefined
    });

    expect(shouldProcess).toBe(true);
  });

  it("mantem o skip incremental quando o item nao e alvo e nada mudou", () => {
    const shouldProcess = shouldProcessIncrementally({
      item: buildItem(),
      previousState: buildState(),
      currentNotePath: "Series/Severance (2022)/Severance (2022).md",
      forceTargetedSync: false,
      preferObsidianWhenStateMissing: false,
      preferredObsidianWatched: undefined,
      forceFullRebuild: false,
      observedObsidianWatched: undefined,
      observedObsidianWatchlisted: undefined
    });

    expect(shouldProcess).toBe(false);
  });
});
