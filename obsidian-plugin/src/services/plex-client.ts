import { requestUrl } from "obsidian";
import { XMLParser } from "fast-xml-parser";
import { parseItemsXml, parseSectionsXml } from "../core/plex-xml-parser";
import { toNumber } from "../core/utils";
import type { PlexEpisodeInfo, PlexMediaItem, PlexSeasonInfo, PlexSection } from "../types";
import { Logger } from "./logger";

interface PmsClientOptions {
  baseUrl: string;
  token: string;
  timeoutSeconds: number;
}

type RequestFn = typeof requestUrl;

interface PlexHttpResponse {
  status: number;
  text: string;
}

export class PmsClient {
  private baseUrl: string;
  private token: string;
  private timeoutSeconds: number;
  private logger: Logger;
  private requestFn: RequestFn;

  constructor(options: PmsClientOptions, logger: Logger, requestFn: RequestFn = requestUrl) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.timeoutSeconds = options.timeoutSeconds;
    this.logger = logger;
    this.requestFn = requestFn;
  }

  async listSections(): Promise<PlexSection[]> {
    const xml = await this.requestXml("GET", "/library/sections");
    return parseSectionsXml(xml);
  }

  async listLibraryItems(sectionKey: string, libraryTitle: string): Promise<PlexMediaItem[]> {
    const xml = await this.requestXml("GET", `/library/sections/${sectionKey}/all`);
    return parseItemsXml(xml, libraryTitle);
  }

  async markWatched(ratingKey: string, watched: boolean): Promise<void> {
    const endpoint = watched ? "/:/scrobble" : "/:/unscrobble";
    await this.requestXml("PUT", endpoint, { key: ratingKey }, true);
  }

  async getShowSeasons(showRatingKey: string): Promise<PlexSeasonInfo[]> {
    const seasonsXml = await this.requestXml(
      "GET",
      `/library/metadata/${encodeURIComponent(showRatingKey)}/children`
    );
    const seasonNodes = parseMediaNodes(seasonsXml).filter(
      (entry) => asString(entry.type) === "season"
    );

    const seasons = await Promise.all(
      seasonNodes.map(async (seasonNode) => {
        const seasonRatingKey = asString(seasonNode.ratingKey);
        if (!seasonRatingKey) {
          return undefined;
        }

        const episodesXml = await this.requestXml(
          "GET",
          `/library/metadata/${encodeURIComponent(seasonRatingKey)}/children`
        );
        const episodeNodes = parseMediaNodes(episodesXml).filter(
          (entry) => asString(entry.type) === "episode"
        );

        const episodes = episodeNodes
          .map((entry) => toEpisodeInfo(entry))
          .filter((entry): entry is PlexEpisodeInfo => entry !== undefined);

        const seasonNumber = toNumber(seasonNode.index);
        const watchedEpisodeCount = toNumber(seasonNode.viewedLeafCount);
        const season: PlexSeasonInfo = {
          ratingKey: seasonRatingKey,
          title: asString(seasonNode.title) || `Temporada ${seasonNumber || "?"}`,
          seasonNumber,
          episodeCount: toNumber(seasonNode.leafCount) ?? episodes.length,
          watchedEpisodeCount:
            watchedEpisodeCount ?? episodes.filter((entry) => entry.watched).length,
          summary: asString(seasonNode.summary),
          rating: toNumber(seasonNode.rating),
          ratingImage: asString(seasonNode.ratingImage),
          audienceRating: toNumber(seasonNode.audienceRating),
          audienceRatingImage: asString(seasonNode.audienceRatingImage),
          thumb: asString(seasonNode.thumb),
          art: asString(seasonNode.art),
          episodes
        };

        return season;
      })
    );

    return seasons
      .filter((entry): entry is PlexSeasonInfo => entry !== undefined)
      .sort((a, b) => {
        const aNumber = typeof a.seasonNumber === "number" ? a.seasonNumber : Number.MAX_SAFE_INTEGER;
        const bNumber = typeof b.seasonNumber === "number" ? b.seasonNumber : Number.MAX_SAFE_INTEGER;
        if (aNumber !== bNumber) {
          return aNumber - bNumber;
        }
        return a.title.localeCompare(b.title, "pt-BR");
      });
  }

  private async requestXml(
    method: "GET" | "PUT",
    path: string,
    query: Record<string, string> = {},
    expectEmptyBody = false
  ): Promise<string> {
    const first = await this.requestOnce(method, path, query, false);

    if (first.status >= 200 && first.status < 300) {
      return first.text;
    }

    const shouldRetry = first.status === 401 || first.status === 403;
    if (shouldRetry) {
      const fallback = await this.requestOnce(method, path, query, true);
      if (fallback.status >= 200 && fallback.status < 300) {
        return fallback.text;
      }
      throw new Error(
        `Erro Plex ${method} ${path}: status=${fallback.status} body=${truncateBody(fallback.text)}`
      );
    }

    if (expectEmptyBody && first.status === 204) {
      return "";
    }

    throw new Error(`Erro Plex ${method} ${path}: status=${first.status} body=${truncateBody(first.text)}`);
  }

  private async requestOnce(
    method: "GET" | "PUT",
    path: string,
    query: Record<string, string>,
    includeTokenInQuery: boolean
  ): Promise<PlexHttpResponse> {
    const resolvedUrl = this.buildUrl(path, query, includeTokenInQuery);
    const headers: Record<string, string> = {
      Accept: "application/xml"
    };

    if (!includeTokenInQuery) {
      headers["X-Plex-Token"] = this.token;
    }

    this.logger.debug(`Plex request ${method} ${maskTokenInUrl(resolvedUrl)} timeout=${this.timeoutSeconds}s`);

    const response = await withTimeout(
      this.requestFn({
        url: resolvedUrl,
        method,
        headers,
        throw: false,
        contentType: "application/xml"
      }),
      this.timeoutSeconds * 1000,
      `Timeout Plex ${method} ${path}`
    );

    return {
      status: response.status,
      text: response.text
    };
  }

  private buildUrl(path: string, query: Record<string, string>, includeTokenInQuery: boolean): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      params.set(key, value);
    }

    if (includeTokenInQuery) {
      params.set("X-Plex-Token", this.token);
    }

    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: true,
  trimValues: true
});

function parseMediaNodes(xml: string): Record<string, unknown>[] {
  const root = parser.parse(xml) as Record<string, unknown>;
  const media =
    root.MediaContainer && typeof root.MediaContainer === "object"
      ? (root.MediaContainer as Record<string, unknown>)
      : {};

  const videos = ensureArray(media.Video);
  const directories = ensureArray(media.Directory);
  return [...videos, ...directories];
}

function ensureArray(value: unknown): Record<string, unknown>[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "object" && entry !== null) as Record<
      string,
      unknown
    >[];
  }
  if (typeof value === "object") {
    return [value as Record<string, unknown>];
  }
  return [];
}

function toEpisodeInfo(node: Record<string, unknown>): PlexEpisodeInfo | undefined {
  const ratingKey = asString(node.ratingKey);
  const title = asString(node.title);
  if (!ratingKey || !title) {
    return undefined;
  }

  const viewCount = toNumber(node.viewCount);
  return {
    ratingKey,
    title,
    seasonNumber: toNumber(node.parentIndex),
    episodeNumber: toNumber(node.index),
    watched: Boolean(viewCount && viewCount > 0),
    durationMs: toNumber(node.duration),
    summary: asString(node.summary)
  };
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function maskTokenInUrl(url: string): string {
  return url.replace(/X-Plex-Token=[^&]+/g, "X-Plex-Token=***");
}

function truncateBody(text: string): string {
  if (!text) {
    return "";
  }
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 250 ? `${compact.slice(0, 250)}...` : compact;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timer);
        reject(error);
      });
  });
}
