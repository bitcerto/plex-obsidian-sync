import { describe, expect, it } from "vitest";
import {
  applyManagedSeriesSection,
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
      nota_pessoal: "ok"
    };

    const managed = {
      plex_rating_key: "123",
      biblioteca: "Filmes",
      assistido: true
    } as never;

    const merged = mergeFrontmatter(existing, managed);
    expect(merged.assistido).toBe(true);
    expect(merged.nota_pessoal).toBe("ok");
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

  it("renderiza secoes de temporadas e episodios para series", () => {
    const body = applyManagedSeriesSection("# Origem\n\nConteudo livre.\n", {
      ...buildItem({ type: "show", title: "Origem" }),
      seasons: [
        {
          ratingKey: "s1",
          title: "Temporada 1",
          seasonNumber: 1,
          episodeCount: 2,
          watchedEpisodeCount: 1,
          episodes: [
            {
              ratingKey: "e1",
              title: "Piloto",
              seasonNumber: 1,
              episodeNumber: 1,
              watched: true
            },
            {
              ratingKey: "e2",
              title: "O Segredo",
              seasonNumber: 1,
              episodeNumber: 2,
              watched: false
            }
          ]
        }
      ]
    });

    expect(body).toContain("## Temporadas e episodios");
    expect(body).toContain("### Temporada 1 (1/2 assistidos)");
    expect(body).toContain("- [x] 01 - Piloto");
    expect(body).toContain("- [ ] 02 - O Segredo");
    expect(body).toContain("Conteudo livre.");
  });
});
