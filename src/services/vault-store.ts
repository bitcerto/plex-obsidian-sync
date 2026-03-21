import { App, TFile } from "obsidian";
import matter from "gray-matter";
import {
  getPropertyAliases,
  MANAGED_KEYS,
  PROPERTY_KEY_ALIASES_REVERSE
} from "../core/constants";
import { normalizeVaultPath } from "../core/utils";
import type { NoteData, PlexSyncSettings } from "../types";

type FrontmatterAliasSettings = Pick<
  PlexSyncSettings,
  "frontmatterKeyLanguage" | "obsidianLocale" | "plexAccountLocale"
>;

export class VaultStore {
  private app: App;
  private settingsProvider?: () => FrontmatterAliasSettings;

  constructor(app: App, settingsProvider?: () => FrontmatterAliasSettings) {
    this.app = app;
    this.settingsProvider = settingsProvider;
  }

  async ensureFolder(folderPath: string): Promise<void> {
    const normalized = normalizeVaultPath(folderPath);
    if (normalized.length === 0 || normalized === "/") {
      return;
    }

    const parts = normalized.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const currentPath = normalizeVaultPath(current);
      const exists = await this.app.vault.adapter.exists(currentPath);
      if (!exists) {
        await this.app.vault.adapter.mkdir(currentPath);
      }
    }
  }

  async readNote(path: string): Promise<NoteData> {
    const normalized = normalizeVaultPath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      return {
        exists: false,
        path: normalized,
        content: "",
        body: "",
        frontmatter: {},
        mtimeMs: 0
      };
    }

    const content = await this.app.vault.read(file);
    const parsed = matter(content);
    const data = isRecord(parsed.data) ? normalizeFrontmatterKeys(parsed.data) : {};

    return {
      exists: true,
      path: normalized,
      content,
      body: parsed.content,
      frontmatter: data,
      mtimeMs: file.stat.mtime
    };
  }

  renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
    const ordered = orderFrontmatter(frontmatter);
    const externalKeys = denormalizeFrontmatterKeys(
      ordered,
      resolveAliasSettings(this.settingsProvider)
    );
    const normalizedBody = body.replace(/^\n+/, "");
    const rendered = matter.stringify(normalizedBody, externalKeys);

    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  }

  async writeNote(path: string, markdown: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    await this.ensureFolder(getParentFolder(normalized));

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, markdown);
      return;
    }

    await this.app.vault.create(normalized, markdown);
  }

  async fileExists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(normalizeVaultPath(path));
  }

  async readJson<T>(path: string): Promise<T | undefined> {
    const normalized = normalizeVaultPath(path);
    const exists = await this.app.vault.adapter.exists(normalized);
    if (!exists) {
      return undefined;
    }

    const raw = await this.app.vault.adapter.read(normalized);
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async readRaw(path: string): Promise<string | undefined> {
    const normalized = normalizeVaultPath(path);
    const exists = await this.app.vault.adapter.exists(normalized);
    if (!exists) {
      return undefined;
    }
    return this.app.vault.adapter.read(normalized);
  }

  async writeJson(path: string, payload: unknown): Promise<void> {
    const normalized = normalizeVaultPath(path);
    await this.ensureFolder(getParentFolder(normalized));

    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const exists = await this.app.vault.adapter.exists(normalized);
    if (exists) {
      await this.app.vault.adapter.write(normalized, text);
      return;
    }

    await this.app.vault.adapter.write(normalized, text);
  }

  async removeAdapterFile(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    const exists = await this.app.vault.adapter.exists(normalized);
    if (!exists) {
      return;
    }
    await this.app.vault.adapter.remove(normalized);
  }

  async moveAdapterFile(fromPath: string, toPath: string): Promise<void> {
    const from = normalizeVaultPath(fromPath);
    const to = normalizeVaultPath(toPath);
    await this.ensureFolder(getParentFolder(to));
    await this.app.vault.adapter.rename(from, to);
  }
}

function getParentFolder(path: string): string {
  const normalized = normalizeVaultPath(path);
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) {
    return "";
  }
  return normalized.slice(0, idx);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function orderFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};

  for (const key of MANAGED_KEYS) {
    if (key in frontmatter) {
      ordered[key] = frontmatter[key];
    }
  }

  for (const key of Object.keys(frontmatter)) {
    if (!(key in ordered)) {
      ordered[key] = frontmatter[key];
    }
  }

  return ordered;
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
    delete normalized[external];
  }

  return normalized;
}

function denormalizeFrontmatterKeys(
  frontmatter: Record<string, unknown>,
  aliasSettings: FrontmatterAliasSettings
): Record<string, unknown> {
  const aliases = getPropertyAliases(aliasSettings);
  const denormalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(frontmatter)) {
    const external = aliases[key] ?? key;
    denormalized[external] = value;
  }

  return denormalized;
}

function resolveAliasSettings(
  settingsProvider?: () => FrontmatterAliasSettings
): FrontmatterAliasSettings {
  if (!settingsProvider) {
    return {
      frontmatterKeyLanguage: "pt_br",
      obsidianLocale: "pt-BR",
      plexAccountLocale: "pt-BR"
    };
  }
  try {
    return settingsProvider();
  } catch {
    return {
      frontmatterKeyLanguage: "pt_br",
      obsidianLocale: "pt-BR",
      plexAccountLocale: "pt-BR"
    };
  }
}
