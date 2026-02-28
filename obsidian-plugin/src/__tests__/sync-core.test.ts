import { describe, expect, it } from "vitest";
import {
  buildManagedMetadata,
  mergeFrontmatter,
  plexWatched,
  resolveConflictWinner
} from "../core/sync-core";
import type { PlexMediaItem } from "../types";

function buildItem(overrides: Partial<PlexMediaItem> = {}): PlexMediaItem {
  return {
    ratingKey: "123",
    type: "movie",
    title: "Cidade de Deus",
    libraryTitle: "Filmes",
    updatedAt: 1700000000,
    ...overrides
  };
}

describe("sync-core", () => {
  it("detecta watched por viewCount", () => {
    expect(plexWatched(buildItem({ viewCount: 1 }))).toBe(true);
    expect(plexWatched(buildItem({ viewCount: 0 }))).toBe(false);
  });

  it("detecta watched para show por leaf counters", () => {
    const show = buildItem({ type: "show", viewCount: undefined, leafCount: 10, viewedLeafCount: 10 });
    expect(plexWatched(show)).toBe(true);
  });

  it("resolve conflito latest por timestamp", () => {
    const winnerOlderNote = resolveConflictWinner("latest", 1000, 2000, 2000);
    const winnerNewerNote = resolveConflictWinner("latest", 2_500_000, 2000, 2000);

    expect(winnerOlderNote).toBe("plex");
    expect(winnerNewerNote).toBe("obsidian");
  });

  it("preserva campos customizados no merge", () => {
    const existing = {
      assistido: false,
      tags: ["filme", "acao"],
      minha_nota: "ok"
    };

    const managed = {
      plex_rating_key: "123",
      biblioteca: "Filmes",
      assistido: true
    } as never;

    const merged = mergeFrontmatter(existing, managed);
    expect(merged.assistido).toBe(true);
    expect(merged.minha_nota).toBe("ok");
    expect(merged.tags).toEqual(["filme", "acao"]);
  });

  it("gera metadados gerenciados com sync fields", () => {
    const meta = buildManagedMetadata({
      item: buildItem({ viewCount: 1 }),
      watched: true,
      syncSource: "plex",
      existingMeta: {},
      noteExists: false
    });

    expect(meta.plex_rating_key).toBe("123");
    expect(meta.assistido).toBe(true);
    expect(meta.sincronizado_por).toBe("plex");
    expect(meta.sincronizado_em).toBeTruthy();
  });
});
