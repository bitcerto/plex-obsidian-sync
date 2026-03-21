import { App, TFile } from "obsidian";
import { PROPERTY_KEY_ALIASES_REVERSE } from "../core/constants";
import { normalizeVaultPath, parseBool } from "../core/utils";
import type { PlexMediaItem, PlexSyncSettings } from "../types";
import { VaultStore } from "./vault-store";

export interface NotePathScanResult {
  mapping: Map<string, string>;
  observedWatchedByRatingKey: Map<string, boolean>;
  observedWatchlistedByRatingKey: Map<string, boolean>;
}

export async function scanManagedNoteIndex(params: {
  app: App;
  store: VaultStore;
  noteRoot: string;
}): Promise<NotePathScanResult> {
  const { app, store, noteRoot } = params;
  const root = normalizeVaultPath(noteRoot);
  const rootPrefix = root.length > 0 ? `${root}/` : "";
  const mapping = new Map<string, string>();
  const observedWatchedByRatingKey = new Map<string, boolean>();
  const observedWatchlistedByRatingKey = new Map<string, boolean>();

  const files = app.vault.getMarkdownFiles();
  for (const file of files) {
    const filePath = normalizeVaultPath(file.path);
    if (!filePath.startsWith(rootPrefix)) {
      continue;
    }

    const noteFrontmatter = await readNoteFrontmatterFast(app, store, filePath);
    const ratingKey = noteFrontmatter.plex_rating_key;
    if (typeof ratingKey !== "string" || ratingKey.trim().length === 0) {
      continue;
    }
    const noteType = noteFrontmatter.tipo;
    if (typeof noteType === "string" && noteType !== "movie" && noteType !== "show") {
      continue;
    }

    const relativePath = filePath.slice(rootPrefix.length);
    const normalizedRatingKey = ratingKey.trim();
    mapping.set(normalizedRatingKey, relativePath);
    observedWatchedByRatingKey.set(
      normalizedRatingKey,
      parseBool(noteFrontmatter.assistido, false)
    );
    observedWatchlistedByRatingKey.set(
      normalizedRatingKey,
      parseBool(
        noteFrontmatter.na_lista_para_assistir ?? noteFrontmatter.na_watchlist,
        false
      )
    );
  }

  return {
    mapping,
    observedWatchedByRatingKey,
    observedWatchlistedByRatingKey
  };
}

export async function readNoteFrontmatterFast(
  app: App,
  store: VaultStore,
  path: string
): Promise<Record<string, unknown>> {
  const normalized = normalizeVaultPath(path);
  const file = app.vault.getAbstractFileByPath(normalized);
  const cached =
    file instanceof TFile ? app.metadataCache.getFileCache(file)?.frontmatter : undefined;
  if (isRecord(cached)) {
    return normalizeFrontmatterKeys(cached);
  }
  const note = await store.readNote(normalized);
  return note.frontmatter;
}

export async function resolveNotePath(params: {
  item: PlexMediaItem;
  noteRoot: string;
  previousRelativePath: string | undefined;
  settings: PlexSyncSettings;
  mappedRelativePath: string | undefined;
  store: VaultStore;
}): Promise<{ absolutePath: string; relativePath: string }> {
  const { item, noteRoot, previousRelativePath, settings, mappedRelativePath, store } = params;
  const { relativePath: canonicalRelativePath, absolutePath: canonicalAbsolutePath } =
    await resolveCanonicalPath(item, noteRoot, settings, store);

  if (previousRelativePath) {
    const previousAbsolute = normalizeVaultPath(noteRoot, previousRelativePath);
    const exists = await store.fileExists(previousAbsolute);
    if (exists) {
      if (previousRelativePath !== canonicalRelativePath) {
        const canonicalExists = await store.fileExists(canonicalAbsolutePath);
        if (!canonicalExists) {
          await store.moveAdapterFile(previousAbsolute, canonicalAbsolutePath);
          return {
            absolutePath: canonicalAbsolutePath,
            relativePath: canonicalRelativePath
          };
        }
      }
      return {
        absolutePath: previousAbsolute,
        relativePath: previousRelativePath
      };
    }
  }

  if (mappedRelativePath) {
    const mappedAbsolute = normalizeVaultPath(noteRoot, mappedRelativePath);
    const exists = await store.fileExists(mappedAbsolute);
    if (exists) {
      if (mappedRelativePath !== canonicalRelativePath) {
        const canonicalExists = await store.fileExists(canonicalAbsolutePath);
        if (!canonicalExists) {
          await store.moveAdapterFile(mappedAbsolute, canonicalAbsolutePath);
          return {
            absolutePath: canonicalAbsolutePath,
            relativePath: canonicalRelativePath
          };
        }
      }
      return {
        absolutePath: mappedAbsolute,
        relativePath: mappedRelativePath
      };
    }
  }

  return {
    absolutePath: canonicalAbsolutePath,
    relativePath: canonicalRelativePath
  };
}

async function resolveCanonicalPath(
  item: PlexMediaItem,
  noteRoot: string,
  settings: PlexSyncSettings,
  store: VaultStore
): Promise<{ absolutePath: string; relativePath: string }> {
  const targetFolder = mediaTypeFolder(item.type, settings.obsidianLocale);
  const baseName = buildPreferredFileBaseName(item);

  for (let attempt = 0; attempt < 500; attempt += 1) {
    const numberedBase = buildNumberedBaseName(baseName, attempt);
    const relativePath = buildMediaRelativePath(item.type, targetFolder, numberedBase);
    const absolutePath = normalizeVaultPath(noteRoot, relativePath);
    const exists = await store.fileExists(absolutePath);

    if (!exists) {
      return {
        absolutePath,
        relativePath
      };
    }

    const existingNote = await store.readNote(absolutePath);
    const existingRatingKey = existingNote.frontmatter.plex_rating_key;
    if (
      typeof existingRatingKey === "string" &&
      existingRatingKey.trim() === item.ratingKey
    ) {
      return {
        absolutePath,
        relativePath
      };
    }
  }

  const fallbackBase = `${baseName} - ${item.ratingKey.slice(-6)}`;
  const fallbackRelativePath = buildMediaRelativePath(item.type, targetFolder, fallbackBase);
  return {
    absolutePath: normalizeVaultPath(noteRoot, fallbackRelativePath),
    relativePath: fallbackRelativePath
  };
}

function mediaTypeFolder(type: string, obsidianLocale: string): string {
  const locale = (obsidianLocale || "").trim().toLowerCase();
  const isPortuguese = locale.startsWith("pt");
  if (type === "show") {
    return isPortuguese ? "Series" : "Series";
  }
  return isPortuguese ? "Filmes" : "Movies";
}

function buildPreferredFileBaseName(item: PlexMediaItem): string {
  const sanitizedTitle = sanitizeFileNameSegment(item.title);
  if (typeof item.year === "number" && Number.isFinite(item.year)) {
    const year = Math.floor(item.year);
    if (year >= 1800 && year <= 3000) {
      return `${sanitizedTitle} (${year})`;
    }
  }

  return sanitizedTitle;
}

function sanitizeFileNameSegment(value: string): string {
  const cleaned = (value || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return cleaned.length > 0 ? cleaned : "Item";
}

function buildNumberedBaseName(baseName: string, attempt: number): string {
  if (attempt === 0) {
    return baseName;
  }

  return `${baseName} - ${attempt + 1}`;
}

function buildMediaRelativePath(type: string, rootFolder: string, baseName: string): string {
  if (type === "show") {
    return normalizeVaultPath(rootFolder, baseName, `${baseName}.md`);
  }
  return normalizeVaultPath(rootFolder, `${baseName}.md`);
}

function normalizeFrontmatterKeys(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...frontmatter };
  for (const [external, canonical] of Object.entries(PROPERTY_KEY_ALIASES_REVERSE)) {
    if (!(external in normalized)) {
      continue;
    }
    if (!(canonical in normalized)) {
      normalized[canonical] = normalized[external];
    }
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
