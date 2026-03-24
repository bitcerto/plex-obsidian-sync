import type { ConflictPolicy, ManagedFrontmatter, PlexMediaItem } from "../types";
import { MANAGED_KEYS } from "./constants";
import { epochSecondsToIso, nowIso } from "./utils";

const SERIES_SECTION_START = "<!-- plex-series-details:start -->";
const SERIES_SECTION_END = "<!-- plex-series-details:end -->";

export function plexWatched(item: PlexMediaItem): boolean {
  if (
    typeof item.leafCount === "number" &&
    typeof item.viewedLeafCount === "number" &&
    item.leafCount > 0
  ) {
    return item.viewedLeafCount >= item.leafCount;
  }

  if (typeof item.viewCount === "number") {
    return item.viewCount > 0;
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
    ultima_visualizacao_plex: epochSecondsToIso(item.lastViewedAt),
    atualizado_plex_em: epochSecondsToIso(item.updatedAt),
    minha_nota: typeof existingMeta.minha_nota === "number" ? existingMeta.minha_nota : ""
  };
  if (!noteExists || syncSource !== "none") {
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
    if (value !== undefined && value !== null && (value !== "" || key === "pausa" || key === "minha_nota")) {
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

export function defaultBody(title: string, posterUrl?: string): string {
  const poster = posterUrl ? `![](${posterUrl})\n\n` : "";
  return `${poster}# ${title}\n\nNota sincronizada automaticamente com Plex.\n\nEdite o campo \`assistido\` no frontmatter para enviar alteracoes ao Plex.\n`;
}

export function applyManagedSeriesSection(body: string, item: PlexMediaItem): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const withoutSection = normalized
    .replace(
      /<!-- plex-series-details:start -->[\s\S]*?<!-- plex-series-details:end -->\n?/g,
      ""
    )
    .trimEnd();

  if (item.type !== "show" || !item.seasons || item.seasons.length === 0) {
    return withoutSection.length > 0 ? `${withoutSection}\n` : "";
  }

  const section = renderSeriesSection(item);
  const prefix = withoutSection.length > 0 ? `${withoutSection}\n\n` : "";
  return `${prefix}${section}\n`;
}

function renderSeriesSection(item: PlexMediaItem): string {
  const seasons = [...(item.seasons || [])].sort((a, b) => {
    const aIndex = typeof a.seasonNumber === "number" ? a.seasonNumber : Number.MAX_SAFE_INTEGER;
    const bIndex = typeof b.seasonNumber === "number" ? b.seasonNumber : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }
    return a.title.localeCompare(b.title);
  });

  const lines: string[] = [SERIES_SECTION_START, "## Temporadas e episodios", ""];

  for (const season of seasons) {
    const seasonName =
      typeof season.seasonNumber === "number"
        ? `Temporada ${season.seasonNumber}`
        : season.title || "Temporada";
    const totalEpisodes =
      typeof season.episodeCount === "number" ? season.episodeCount : season.episodes.length;
    const watchedEpisodes =
      typeof season.watchedEpisodeCount === "number"
        ? season.watchedEpisodeCount
        : season.episodes.filter((entry) => entry.watched).length;

    lines.push(`### ${seasonName} (${watchedEpisodes}/${totalEpisodes} assistidos)`);

    const episodes = [...season.episodes].sort((a, b) => {
      const aNum = typeof a.episodeNumber === "number" ? a.episodeNumber : Number.MAX_SAFE_INTEGER;
      const bNum = typeof b.episodeNumber === "number" ? b.episodeNumber : Number.MAX_SAFE_INTEGER;
      if (aNum !== bNum) {
        return aNum - bNum;
      }
      return a.title.localeCompare(b.title);
    });

    for (const episode of episodes) {
      const check = episode.watched ? "x" : " ";
      const label = buildEpisodeLabel(episode.episodeNumber, episode.title);
      lines.push(`- [${check}] ${label}`);
    }

    lines.push("");
  }

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  lines.push(SERIES_SECTION_END);

  return lines.join("\n");
}

function buildEpisodeLabel(episodeNumber: number | undefined, title: string): string {
  if (typeof episodeNumber === "number") {
    return `${String(episodeNumber).padStart(2, "0")} - ${title}`;
  }
  return title;
}
