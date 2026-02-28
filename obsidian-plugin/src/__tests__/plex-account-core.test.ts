import { describe, expect, it } from "vitest";
import {
  buildPlexAuthUrl,
  orderConnections,
  tokenCandidates
} from "../core/plex-account-core";

describe("plex-account-core", () => {
  it("monta URL de auth do Plex com PIN", () => {
    const url = buildPlexAuthUrl("client-1", "abc123", "Plex Obsidian Sync");
    expect(url).toContain("app.plex.tv/auth");
    expect(url).toContain("clientID=client-1");
    expect(url).toContain("code=abc123");
  });

  it("ordena conexoes remote_first", () => {
    const ordered = orderConnections(
      [
        { uri: "http://local", local: true },
        { uri: "https://remote", local: false }
      ],
      "remote_first"
    );

    expect(ordered[0].uri).toBe("https://remote");
    expect(ordered[1].uri).toBe("http://local");
  });

  it("local_only retorna somente conexoes locais", () => {
    const ordered = orderConnections(
      [
        { uri: "http://local", local: true },
        { uri: "https://remote", local: false }
      ],
      "local_only"
    );

    expect(ordered).toHaveLength(1);
    expect(ordered[0].uri).toBe("http://local");
  });

  it("gera fallback de tokens sem duplicar", () => {
    expect(tokenCandidates("server-token", "account-token")).toEqual([
      "server-token",
      "account-token"
    ]);

    expect(tokenCandidates("same-token", "same-token")).toEqual(["same-token"]);
    expect(tokenCandidates(undefined, "account-token")).toEqual(["account-token"]);
  });
});
