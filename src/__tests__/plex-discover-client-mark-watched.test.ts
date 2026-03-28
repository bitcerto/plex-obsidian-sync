import { beforeAll, describe, expect, it, vi } from "vitest";
import { PlexDiscoverClient } from "../services/plex-discover-client";
import { Logger } from "../services/logger";

beforeAll(() => {
  vi.stubGlobal("window", globalThis);
});

describe("plex-discover-client markWatched", () => {
  it("usa discover provider com ratingKey antes do fallback em metadata", async () => {
    const requestFn = vi.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);

      if (parsed.hostname === "discover.provider.plex.tv" && parsed.pathname === "/actions/scrobble") {
        return {
          status: 200,
          text: ""
        };
      }

      if (
        parsed.hostname === "metadata.provider.plex.tv" &&
        parsed.pathname === "/library/metadata/season-1/userState"
      ) {
        return {
          status: 200,
          text: JSON.stringify({
            MediaContainer: {
              UserState: {
                viewedLeafCount: 10,
                leafCount: 10
              }
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

    await client.markWatched("season-1", true);

    expect(requestFn).toHaveBeenCalledTimes(3);
    const firstUrl = new URL(requestFn.mock.calls[0][0].url);
    expect(firstUrl.origin).toBe("https://discover.provider.plex.tv");
    expect(firstUrl.pathname).toBe("/actions/scrobble");
    expect(firstUrl.searchParams.get("ratingKey")).toBe("season-1");
    expect(firstUrl.searchParams.get("key")).toBeNull();
    expect(firstUrl.searchParams.get("identifier")).toBeNull();
    const timelineUrl = requestFn.mock.calls
      .map((call) => new URL(call[0].url))
      .find((entry) => entry.pathname === "/timeline");
    expect(timelineUrl).toBeUndefined();
  });

  it("faz fallback para metadata provider quando discover nao confirma o estado", async () => {
    let metadataActionCalled = false;
    const requestFn = vi.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);

      if (parsed.hostname === "discover.provider.plex.tv" && parsed.pathname === "/actions/scrobble") {
        return {
          status: 200,
          text: ""
        };
      }

      if (parsed.hostname === "metadata.provider.plex.tv" && parsed.pathname === "/actions/scrobble") {
        metadataActionCalled = true;
        return {
          status: 200,
          text: ""
        };
      }

      if (
        parsed.hostname === "metadata.provider.plex.tv" &&
        parsed.pathname === "/library/metadata/season-1/userState"
      ) {
        return {
          status: 200,
          text: JSON.stringify({
            MediaContainer: {
              UserState: metadataActionCalled
                ? {
                    viewedLeafCount: 10,
                    leafCount: 10
                  }
                : {
                    viewedLeafCount: 0,
                    leafCount: 10
                  }
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

    await client.markWatched("season-1", true);

    expect(metadataActionCalled).toBe(true);
    const actionUrls = requestFn.mock.calls
      .map((call) => new URL(call[0].url))
      .filter((url) => url.pathname === "/actions/scrobble");

    expect(actionUrls).toHaveLength(2);
    expect(actionUrls[0].origin).toBe("https://discover.provider.plex.tv");
    expect(actionUrls[0].searchParams.get("ratingKey")).toBe("season-1");
    expect(actionUrls[1].origin).toBe("https://metadata.provider.plex.tv");
    expect(actionUrls[1].searchParams.get("key")).toBe("season-1");
    expect(actionUrls[1].searchParams.get("identifier")).toBe("com.plexapp.plugins.library");
    expect(actionUrls[1].searchParams.get("ratingKey")).toBeNull();
  });

  it("publica historico via timeline quando marca episodio como assistido", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const requestFn = vi.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);

      if (parsed.hostname === "discover.provider.plex.tv" && parsed.pathname === "/actions/scrobble") {
        return {
          status: 200,
          text: ""
        };
      }

      if (
        parsed.hostname === "metadata.provider.plex.tv" &&
        parsed.pathname === "/library/metadata/episode-1/userState"
      ) {
        return {
          status: 200,
          text: JSON.stringify({
            MediaContainer: {
              UserState: {
                viewCount: 1
              }
            }
          })
        };
      }

      if (
        parsed.hostname === "discover.provider.plex.tv" &&
        parsed.pathname === "/library/metadata/episode-1"
      ) {
        return {
          status: 200,
          text: JSON.stringify({
            MediaContainer: {
              Metadata: {
                ratingKey: "episode-1",
                type: "episode",
                duration: 300000,
                key: "/library/metadata/episode-1",
                guid: "plex://episode/episode-1"
              }
            }
          })
        };
      }

      if (parsed.hostname === "discover.provider.plex.tv" && parsed.pathname === "/timeline") {
        return {
          status: 200,
          text: ""
        };
      }

      if (
        parsed.hostname === "discover.provider.plex.tv" &&
        (parsed.pathname === "/library/sections/history/all" || parsed.pathname === "/library/history/all")
      ) {
        return {
          status: 200,
          text: JSON.stringify({
            MediaContainer: {
              Metadata: [
                {
                  ratingKey: "episode-1",
                  viewedAt: 1_799_999_990
                }
              ]
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

    try {
      await client.markWatched("episode-1", true);
    } finally {
      nowSpy.mockRestore();
    }

    const timelineUrl = requestFn.mock.calls
      .map((call) => new URL(call[0].url))
      .find((entry) => entry.pathname === "/timeline");

    expect(timelineUrl?.origin).toBe("https://discover.provider.plex.tv");
    expect(timelineUrl?.searchParams.get("ratingKey")).toBe("episode-1");
    expect(timelineUrl?.searchParams.get("key")).toBe("/library/metadata/episode-1");
    expect(timelineUrl?.searchParams.get("state")).toBe("stopped");
    expect(timelineUrl?.searchParams.get("duration")).toBe("300000");
    expect(timelineUrl?.searchParams.get("guid")).toBe("plex://episode/episode-1");
  });
});
