import type { ConflictPolicy, ManagedFrontmatter, PlexMediaItem } from "../types";
import { MANAGED_KEYS, SYNC_FIELDS } from "./constants";
import { epochSecondsToIso, nowIso } from "./utils";

export function plexWatched(item: PlexMediaItem): boolean {
  if (typeof item.viewCount === "number") {
    return item.viewCount > 0;
  }

  if (
    typeof item.leafCount === "number" &&
    typeof item.viewedLeafCount === "number" &&
    item.leafCount > 0
  ) {
    return item.viewedLeafCount >= item.leafCount;
  }

  return false;
}

export function resolveConflictWinner(
  policy: ConflictPolicy,
  noteMtimeMs: number,
  lastViewedAtSeconds?: number,
  updatedAtSeconds?: number
): "plex" | "obsidian" {
  if (policy === "plex" || policy === "obsidian") {
    return policy;
  }

  const plexTsMs = Math.max((lastViewedAtSeconds || 0) * 1000, (updatedAtSeconds || 0) * 1000);
  return noteMtimeMs >= plexTsMs ? "obsidian" : "plex";
}

export function buildManagedMetadata(params: {
  item: PlexMediaItem;
  watched: boolean;
  syncSource: string;
  existingMeta: Record<string, unknown>;
  noteExists: boolean;
}): ManagedFrontmatter {
  const { item, watched, syncSource, existingMeta, noteExists } = params;

  const base: ManagedFrontmatter = {
    plex_rating_key: item.ratingKey,
    plex_guid: item.guid,
    biblioteca: item.libraryTitle,
    tipo: item.type,
    titulo: item.title,
    titulo_original: item.originalTitle,
    ano: item.year,
    resumo: item.summary,
    nota_critica: item.rating,
    nota_critica_fonte: item.ratingImage,
    nota_publico: item.audienceRating,
    nota_publico_fonte: item.audienceRatingImage,
    capa_url: item.thumb,
    fundo_url: item.art,
    duracao_minutos: item.durationMs ? Math.round(item.durationMs / 60000) : undefined,
    temporadas: item.type === "show" ? item.childCount : undefined,
    episodios: item.type === "show" ? item.leafCount : undefined,
    assistido: watched,
    na_lista_para_assistir: item.inWatchlist,
    ultima_visualizacao_plex: epochSecondsToIso(item.lastViewedAt),
    atualizado_plex_em: epochSecondsToIso(item.updatedAt)
  };
  const baseRecord = base as unknown as Record<string, unknown>;

  const comparableKeys = MANAGED_KEYS.filter((key) => !SYNC_FIELDS.has(key));
  const hasDataChange = comparableKeys.some((key) => {
    return existingMeta[key] !== baseRecord[key];
  });

  if (!noteExists || syncSource !== "none" || hasDataChange) {
    base.sincronizado_em = nowIso();
    base.sincronizado_por = syncSource;
  } else {
    base.sincronizado_em = asString(existingMeta.sincronizado_em);
    base.sincronizado_por = asString(existingMeta.sincronizado_por);
  }

  return base;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function mergeFrontmatter(
  existing: Record<string, unknown>,
  managed: ManagedFrontmatter
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const managedRecord = managed as unknown as Record<string, unknown>;

  for (const key of MANAGED_KEYS) {
    const value = managedRecord[key];
    if (value !== undefined && value !== null && value !== "") {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(existing)) {
    if (!MANAGED_KEYS.includes(key as (typeof MANAGED_KEYS)[number])) {
      merged[key] = value;
    }
  }

  return merged;
}

export function defaultBody(title: string): string {
  return `# ${title}\n\nNota sincronizada automaticamente com Plex.\n\nEdite o campo \`assistido\` no frontmatter para enviar alteracoes ao Plex.\n`;
}
