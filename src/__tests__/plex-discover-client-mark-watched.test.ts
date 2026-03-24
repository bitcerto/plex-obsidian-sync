import { beforeAll, describe, expect, it, vi } from "vitest";
import { PlexDiscoverClient } from "../services/plex-discover-client";
import { Logger } from "../services/logger";

beforeAll(() => {
  vi.stubGlobal("window", globalThis);
});

describe("plex-discover-client markWatched", () => {
  it("usa metadata provider com key e identifier para marcar assistido", async () => {
    const requestFn = vi.fn(async ({ url }: { url: string }) => {
      const parsed = new URL(url);

      if (parsed.hostname === "metadata.provider.plex.tv" && parsed.pathname === "/actions/scrobble") {
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

    expect(requestFn).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(requestFn.mock.calls[0][0].url);
    expect(firstUrl.origin).toBe("https://metadata.provider.plex.tv");
    expect(firstUrl.pathname).toBe("/actions/scrobble");
    expect(firstUrl.searchParams.get("key")).toBe("season-1");
    expect(firstUrl.searchParams.get("identifier")).toBe("com.plexapp.plugins.library");
    expect(firstUrl.searchParams.get("ratingKey")).toBeNull();
  });
});
