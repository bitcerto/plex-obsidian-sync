import { beforeAll, describe, expect, it, vi } from "vitest";
import { PlexDiscoverClient } from "../services/plex-discover-client";
import { Logger } from "../services/logger";
import { PmsClient } from "../services/plex-client";

beforeAll(() => {
  vi.stubGlobal("window", globalThis);
});

describe("plex hierarchy pagination", () => {
  it("carrega todos os itens paginados na biblioteca PMS", async () => {
    const requestFn = vi.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("X-Plex-Container-Start") || "0");

      if (parsed.pathname.endsWith("/library/sections/1/all")) {
        if (start === 0) {
          const firstPageItems = Array.from({ length: 200 }, (_, idx) => {
            const itemNumber = idx + 1;
            return `<Directory ratingKey="show-${itemNumber}" type="show" title="Serie ${itemNumber}" leafCount="10" viewedLeafCount="0" />`;
          }).join("");

          return {
            status: 200,
            text: `<MediaContainer size="200" totalSize="201">${firstPageItems}</MediaContainer>`
          };
        }

        if (start === 200) {
          return {
            status: 200,
            text: `
              <MediaContainer size="1" totalSize="201">
                <Directory ratingKey="show-201" type="show" title="From" leafCount="10" viewedLeafCount="0" />
              </MediaContainer>
            `
          };
        }
      }

      throw new Error(`unexpected request ${url}`);
    });

    const client = new PmsClient(
      {
        baseUrl: "http://127.0.0.1:32400",
        token: "token",
        timeoutSeconds: 5
      },
      new Logger(false),
      requestFn as never
    );

    const items = await client.listLibraryItems("1", "Series");
    const lastItem = items[items.length - 1];

    expect(items).toHaveLength(201);
    expect(lastItem?.title).toBe("From");
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("carrega todos os episódios paginados no PMS", async () => {
    const requestFn = vi.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("X-Plex-Container-Start") || "0");

      if (parsed.pathname.endsWith("/library/metadata/show-1/children")) {
        return {
          status: 200,
          text: `
            <MediaContainer size="1">
              <Directory ratingKey="season-1" type="season" title="Temporada 1" index="1" leafCount="50" />
            </MediaContainer>
          `
        };
      }

      if (parsed.pathname.endsWith("/library/metadata/season-1/children")) {
        const totalEpisodes = 50;
        const count = Math.min(totalEpisodes - start, 200);
        const items = Array.from({ length: count }, (_, idx) => {
          const episodeNumber = start + idx + 1;
          return `<Video ratingKey="ep-${episodeNumber}" type="episode" title="Ep ${episodeNumber}" parentIndex="1" index="${episodeNumber}" />`;
        }).join("");

        return {
          status: 200,
          text: `<MediaContainer size="${count}" totalSize="${totalEpisodes}">${items}</MediaContainer>`
        };
      }

      throw new Error(`unexpected request ${url}`);
    });

    const client = new PmsClient(
      {
        baseUrl: "http://127.0.0.1:32400",
        token: "token",
        timeoutSeconds: 5
      },
      new Logger(false),
      requestFn as never
    );

    const seasons = await client.getShowSeasons("show-1");

    expect(seasons).toHaveLength(1);
    expect(seasons[0].episodes).toHaveLength(50);
    expect(seasons[0].episodes[0].episodeNumber).toBe(1);
    expect(seasons[0].episodes[49].episodeNumber).toBe(50);
  });

  it("carrega todos os episódios paginados no Discover", async () => {
    const requestFn = vi.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("X-Plex-Container-Start") || "0");

      if (parsed.pathname.endsWith("/library/metadata/show-1/children")) {
        return {
          status: 200,
          text: JSON.stringify({
            MediaContainer: {
              Metadata: [
                {
                  ratingKey: "season-1",
                  type: "season",
                  title: "Temporada 1",
                  index: 1,
                  leafCount: 50
                }
              ]
            }
          })
        };
      }

      if (parsed.pathname.endsWith("/library/metadata/season-1/children")) {
        const totalEpisodes = 50;
        const count = Math.min(totalEpisodes - start, 200);
        const metadata = Array.from({ length: count }, (_, idx) => {
          const episodeNumber = start + idx + 1;
          return {
            ratingKey: `ep-${episodeNumber}`,
            type: "episode",
            title: `Ep ${episodeNumber}`,
            parentIndex: 1,
            index: episodeNumber
          };
        });

        return {
          status: 200,
          text: JSON.stringify({
            MediaContainer: {
              totalSize: totalEpisodes,
              Metadata: metadata
            }
          })
        };
      }

      throw new Error(`unexpected request ${url}`);
    });

    const client = new PlexDiscoverClient(
      {
        accountToken: "token",
        clientIdentifier: "client-id",
        product: "Plex Sync",
        timeoutSeconds: 5
      },
      new Logger(false),
      requestFn as never
    );

    const seasons = await client.getShowSeasons("show-1");

    expect(seasons).toHaveLength(1);
    expect(seasons[0].episodes).toHaveLength(50);
    expect(seasons[0].episodes[0].episodeNumber).toBe(1);
    expect(seasons[0].episodes[49].episodeNumber).toBe(50);
  });
});
