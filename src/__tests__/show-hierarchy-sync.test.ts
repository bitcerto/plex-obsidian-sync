import matter from "gray-matter";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "../services/logger";
import { syncShowHierarchy } from "../services/show-hierarchy-sync";
import type { NoteData, PlexMediaItem } from "../types";

class FakeVaultStore {
  private files = new Map<string, string>();

  constructor(initialFiles: Record<string, string>) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, content);
    }
  }

  async readNote(path: string): Promise<NoteData> {
    const content = this.files.get(path);
    if (content === undefined) {
      return {
        exists: false,
        path,
        content: "",
        body: "",
        frontmatter: {},
        mtimeMs: 0
      };
    }

    const parsed = matter(content);
    return {
      exists: true,
      path,
      content,
      body: parsed.content,
      frontmatter: isRecord(parsed.data) ? parsed.data : {},
      mtimeMs: 0
    };
  }

  renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
    const rendered = matter.stringify(body.replace(/^\n+/, ""), frontmatter);
    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  }

  async writeNote(path: string, markdown: string): Promise<void> {
    this.files.set(path, markdown);
  }

  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async moveAdapterFile(fromPath: string, toPath: string): Promise<void> {
    const current = this.files.get(fromPath);
    if (current === undefined) {
      return;
    }
    this.files.delete(fromPath);
    this.files.set(toPath, current);
  }

  async removeAdapterFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  listMarkdownPaths(): string[] {
    return Array.from(this.files.keys()).filter((path) => path.endsWith(".md"));
  }
}

function buildApp(store: FakeVaultStore): {
  vault: {
    getMarkdownFiles(): Array<{ path: string }>;
    adapter: {
      list(path: string): Promise<{ files: string[]; folders: string[] }>;
      rmdir(path: string, recursive: boolean): Promise<void>;
    };
  };
} {
  return {
    vault: {
      getMarkdownFiles: () => store.listMarkdownPaths().map((path) => ({ path })),
      adapter: {
        list: async (path: string) => listFolder(path, store.listMarkdownPaths()),
        rmdir: async () => {}
      }
    }
  };
}

function listFolder(
  folderPath: string,
  allFiles: string[]
): { files: string[]; folders: string[] } {
  const normalizedFolder = folderPath.replace(/\/+$/, "");
  const prefix = normalizedFolder ? `${normalizedFolder}/` : "";
  const files = new Set<string>();
  const folders = new Set<string>();

  for (const filePath of allFiles) {
    if (!filePath.startsWith(prefix)) {
      continue;
    }

    const remainder = filePath.slice(prefix.length);
    if (remainder.length === 0) {
      continue;
    }

    const segments = remainder.split("/");
    if (segments.length === 1) {
      files.add(filePath);
      continue;
    }

    folders.add(`${normalizedFolder}/${segments[0]}`);
  }

  return {
    files: Array.from(files),
    folders: Array.from(folders)
  };
}

function renderNote(frontmatter: Record<string, unknown>, body: string): string {
  return matter.stringify(body.replace(/^\n+/, ""), frontmatter);
}

function buildShowItem(): PlexMediaItem {
  return {
    ratingKey: "show-1",
    type: "show",
    title: "Dark",
    libraryTitle: "Series",
    seasons: [
      {
        ratingKey: "season-1",
        title: "Temporada 1",
        seasonNumber: 1,
        episodeCount: 2,
        watchedEpisodeCount: 0,
        episodes: [
          {
            ratingKey: "ep-1",
            title: "Segredos",
            seasonNumber: 1,
            episodeNumber: 1,
            watched: false
          },
          {
            ratingKey: "ep-2",
            title: "Mentiras",
            seasonNumber: 1,
            episodeNumber: 2,
            watched: false
          }
        ]
      },
      {
        ratingKey: "season-2",
        title: "Temporada 2",
        seasonNumber: 2,
        episodeCount: 2,
        watchedEpisodeCount: 0,
        episodes: [
          {
            ratingKey: "ep-3",
            title: "Ecos",
            seasonNumber: 2,
            episodeNumber: 1,
            watched: false
          },
          {
            ratingKey: "ep-4",
            title: "Loop",
            seasonNumber: 2,
            episodeNumber: 2,
            watched: false
          }
        ]
      }
    ]
  };
}

describe("show-hierarchy-sync", () => {
  it("aplica override de temporada apenas na temporada explicitamente alvo", async () => {
    const noteRoot = "Media-Plex";
    const showFolder = "Series/Dark";
    const store = new FakeVaultStore({
      [`${noteRoot}/${showFolder}/Temporada 1/- Temporada 1.md`]: renderNote(
        {
          tipo: "season",
          plex_rating_key: "season-1",
          serie_rating_key: "show-1",
          assistido: true
        },
        "# Temporada 1\n"
      ),
      [`${noteRoot}/${showFolder}/Temporada 2/- Temporada 2.md`]: renderNote(
        {
          tipo: "season",
          plex_rating_key: "season-2",
          serie_rating_key: "show-1",
          assistido: false
        },
        [
          "# Temporada 2",
          "",
          "<!-- plex-season-episodes:start -->",
          "## Episodios",
          "",
          "- [x] [[Series/Dark/Temporada 2/01 - Ecos|01 - Ecos]] <!-- plex_episode_rating_key:ep-3 -->",
          "- [x] [[Series/Dark/Temporada 2/02 - Loop|02 - Loop]] <!-- plex_episode_rating_key:ep-4 -->",
          "<!-- plex-season-episodes:end -->",
          ""
        ].join("\n")
      )
    });
    const app = buildApp(store);
    const markWatched = vi.fn(async () => {});

    await syncShowHierarchy({
      app: app as never,
      noteRoot,
      showNoteRelativePath: `${showFolder}/Dark.md`,
      showItem: buildShowItem(),
      client: { markWatched },
      overrideSeasonRatingKeys: new Set(["season-1"]),
      logger: new Logger(false),
      store: store as never
    });

    expect(markWatched).toHaveBeenCalledTimes(1);
    expect(markWatched).toHaveBeenCalledWith("season-1", true);

    const updatedSeason1 = await store.readNote(
      `${noteRoot}/${showFolder}/Temporada 1/- Temporada 1.md`
    );
    const updatedSeason2 = await store.readNote(
      `${noteRoot}/${showFolder}/Temporada 2/- Temporada 2.md`
    );

    expect(updatedSeason1.frontmatter.assistido).toBe(true);
    expect(updatedSeason1.frontmatter.episodios_assistidos).toBe(2);
    expect(updatedSeason2.frontmatter.assistido).toBe(false);
    expect(updatedSeason2.frontmatter.episodios_assistidos).toBe(0);
  });

  it("faz fallback para episodios da temporada quando o client nao suporta escrita direta de temporada", async () => {
    const noteRoot = "Media-Plex";
    const showFolder = "Series/Dark";
    const store = new FakeVaultStore({
      [`${noteRoot}/${showFolder}/Temporada 1/- Temporada 1.md`]: renderNote(
        {
          tipo: "season",
          plex_rating_key: "season-1",
          serie_rating_key: "show-1",
          assistido: true
        },
        "# Temporada 1\n"
      ),
      [`${noteRoot}/${showFolder}/Temporada 2/- Temporada 2.md`]: renderNote(
        {
          tipo: "season",
          plex_rating_key: "season-2",
          serie_rating_key: "show-1",
          assistido: false
        },
        "# Temporada 2\n"
      )
    });
    const app = buildApp(store);
    const markWatched = vi.fn(async () => {});

    await syncShowHierarchy({
      app: app as never,
      noteRoot,
      showNoteRelativePath: `${showFolder}/Dark.md`,
      showItem: buildShowItem(),
      client: {
        markWatched,
        supportsSeasonWatchedWrites: false
      },
      overrideSeasonRatingKeys: new Set(["season-1"]),
      logger: new Logger(false),
      store: store as never
    });

    expect(markWatched).toHaveBeenCalledTimes(2);
    expect(markWatched).toHaveBeenNthCalledWith(1, "ep-1", true);
    expect(markWatched).toHaveBeenNthCalledWith(2, "ep-2", true);
  });

  it("nao dispara updates por episodio quando o show ja foi marcado no nivel da serie", async () => {
    const noteRoot = "Media-Plex";
    const showFolder = "Series/Dark";
    const store = new FakeVaultStore({});
    const app = buildApp(store);
    const markWatched = vi.fn(async () => {});

    await syncShowHierarchy({
      app: app as never,
      noteRoot,
      showNoteRelativePath: `${showFolder}/Dark.md`,
      showItem: buildShowItem(),
      client: { markWatched },
      showWatchedOverride: true,
      logger: new Logger(false),
      store: store as never
    });

    expect(markWatched).not.toHaveBeenCalled();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
