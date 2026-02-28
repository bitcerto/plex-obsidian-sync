import { requestUrl } from "obsidian";
import type {
  PlexDiscoverSearchItem,
  PlexEpisodeInfo,
  PlexMediaItem,
  PlexSeasonInfo
} from "../types";
import { toNumber } from "../core/utils";
import { Logger } from "./logger";

type RequestFn = typeof requestUrl;

interface PlexDiscoverClientOptions {
  accountToken: string;
  clientIdentifier: string;
  product: string;
  timeoutSeconds: number;
}

interface DiscoverListResponse {
  MediaContainer?: {
    Metadata?: unknown;
    size?: number;
    totalSize?: number;
  };
}

interface UserStateResponse {
  MediaContainer?: {
    UserState?: Record<string, unknown>;
  };
}

interface DiscoverSearchResponse {
  MediaContainer?: {
    SearchResults?: unknown;
  };
}

interface DiscoverMetadataResponse {
  MediaContainer?: {
    Metadata?: unknown;
  };
}

interface PlexHttpResponse {
  status: number;
  text: string;
}

const DISCOVER_BASE = "https://discover.provider.plex.tv";
const METADATA_BASE = "https://metadata.provider.plex.tv";

export class PlexDiscoverClient {
  private accountToken: string;
  private clientIdentifier: string;
  private product: string;
  private timeoutSeconds: number;
  private logger: Logger;
  private requestFn: RequestFn;

  constructor(
    options: PlexDiscoverClientOptions,
    logger: Logger,
    requestFn: RequestFn = requestUrl
  ) {
    this.accountToken = options.accountToken.trim();
    this.clientIdentifier = options.clientIdentifier;
    this.product = options.product;
    this.timeoutSeconds = options.timeoutSeconds;
    this.logger = logger;
    this.requestFn = requestFn;
  }

  async listWatchlist(): Promise<PlexMediaItem[]> {
    const rawItems: Record<string, unknown>[] = [];
    const pageSize = 100;
    let start = 0;
    let totalSize = Number.POSITIVE_INFINITY;

    while (start < totalSize) {
      const response = await this.requestJson<DiscoverListResponse>(
        "GET",
        `${DISCOVER_BASE}/library/sections/watchlist/all`,
        {
          type: "99",
          sort: "watchlistedAt:desc",
          includeUserState: "1",
          includeCollections: "1",
          includeExternalMedia: "1",
          "X-Plex-Container-Start": String(start),
          "X-Plex-Container-Size": String(pageSize)
        }
      );

      if (!response) {
        break;
      }

      const media = response.MediaContainer;
      const pageItems = ensureArrayOfRecords(media?.Metadata);
      rawItems.push(...pageItems);

      const reportedTotal = toNumber(media?.totalSize);
      const reportedSize = toNumber(media?.size) ?? pageItems.length;
      totalSize = reportedTotal ?? start + reportedSize;

      if (reportedSize <= 0) {
        break;
      }

      start += reportedSize;
    }

    const baseItems = rawItems
      .map((node) => this.toMediaItem(node, "Watchlist"))
      .filter((entry): entry is PlexMediaItem => entry !== undefined);

    const enriched = await Promise.all(
      baseItems.map(async (item) => {
        const metadata = await this.getMetadataDetails(item.ratingKey);
        const state = await this.getUserState(item.ratingKey);
        const withMetadata = this.applyMetadata(item, metadata);
        return this.applyUserState(withMetadata, state);
      })
    );

    return enriched;
  }

  async searchCatalog(query: string, limit = 20): Promise<PlexDiscoverSearchItem[]> {
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }

    const response = await this.requestJson<DiscoverSearchResponse>(
      "GET",
      `${DISCOVER_BASE}/library/search`,
      {
        query: cleaned,
        limit: String(Math.max(1, Math.min(limit, 50))),
        searchTypes: "movies,tv",
        searchProviders: "discover",
        includeMetadata: "1"
      }
    );

    const groups = ensureArrayOfRecords(response?.MediaContainer?.SearchResults);
    const external = groups.find((entry) => asString(entry.id) === "external");
    const candidates = ensureArrayOfRecords(external?.SearchResult);

    const items = candidates
      .map((entry) => this.toSearchItem(extractMetadata(entry)))
      .filter((entry): entry is PlexDiscoverSearchItem => entry !== undefined);

    const dedup = new Map<string, PlexDiscoverSearchItem>();
    for (const item of items) {
      dedup.set(item.ratingKey, item);
    }
    return Array.from(dedup.values());
  }

  async getTrackedItem(ratingKey: string): Promise<PlexMediaItem | undefined> {
    const response = await this.requestJson<DiscoverListResponse>(
      "GET",
      `${DISCOVER_BASE}/library/metadata/${encodeURIComponent(ratingKey)}`,
      {},
      true
    );

    if (!response) {
      return undefined;
    }

    const rawItems = ensureArrayOfRecords(response.MediaContainer?.Metadata);
    const first = rawItems[0];
    if (!first) {
      return undefined;
    }

    const item = this.toMediaItem(first, "Conta Plex");
    if (!item) {
      return undefined;
    }

    const metadata = await this.getMetadataDetails(item.ratingKey);
    const state = await this.getUserState(item.ratingKey);
    const withMetadata = this.applyMetadata(item, metadata);
    return this.applyUserState(withMetadata, state);
  }

  async markWatched(ratingKey: string, watched: boolean): Promise<void> {
    const action = watched ? "scrobble" : "unscrobble";
    await this.requestJson(
      "PUT",
      `${DISCOVER_BASE}/actions/${action}`,
      { key: ratingKey },
      false
    );
  }

  async setWatchlisted(ratingKey: string, watchlisted: boolean): Promise<void> {
    const action = watchlisted ? "addToWatchlist" : "removeFromWatchlist";
    await this.requestJson(
      "PUT",
      `${DISCOVER_BASE}/actions/${action}`,
      { ratingKey },
      false
    );
  }

  async getShowSeasons(showRatingKey: string): Promise<PlexSeasonInfo[]> {
    const seasonsResponse = await this.requestJson<DiscoverMetadataResponse>(
      "GET",
      `${DISCOVER_BASE}/library/metadata/${encodeURIComponent(showRatingKey)}/children`,
      { includeUserState: "1" },
      true
    );

    const seasonNodes = ensureArrayOfRecords(seasonsResponse?.MediaContainer?.Metadata).filter(
      (entry) => asString(entry.type) === "season"
    );
    if (seasonNodes.length === 0) {
      return [];
    }

    const seasons = await Promise.all(
      seasonNodes.map(async (seasonNode) => {
        const seasonRatingKey = asString(seasonNode.ratingKey);
        if (!seasonRatingKey) {
          return undefined;
        }

        const episodesResponse = await this.requestJson<DiscoverMetadataResponse>(
          "GET",
          `${DISCOVER_BASE}/library/metadata/${encodeURIComponent(seasonRatingKey)}/children`,
          { includeUserState: "1" },
          true
        );

        const episodeNodes = ensureArrayOfRecords(episodesResponse?.MediaContainer?.Metadata).filter(
          (entry) => asString(entry.type) === "episode"
        );

        const episodes = episodeNodes
          .map((episodeNode) => toEpisodeInfo(episodeNode))
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

  private async getUserState(ratingKey: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.requestJson<UserStateResponse>(
      "GET",
      `${METADATA_BASE}/library/metadata/${encodeURIComponent(ratingKey)}/userState`,
      {},
      true
    );
    return response?.MediaContainer?.UserState;
  }

  private async getMetadataDetails(ratingKey: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.requestJson<DiscoverMetadataResponse>(
      "GET",
      `${DISCOVER_BASE}/library/metadata/${encodeURIComponent(ratingKey)}`,
      {},
      true
    );
    const raw = ensureArrayOfRecords(response?.MediaContainer?.Metadata);
    return raw[0];
  }

  private applyMetadata(
    item: PlexMediaItem,
    metadata: Record<string, unknown> | undefined
  ): PlexMediaItem {
    if (!metadata) {
      return item;
    }

    return {
      ...item,
      title: asString(metadata.title) ?? item.title,
      originalTitle: asString(metadata.originalTitle) ?? item.originalTitle,
      year: toNumber(metadata.year) ?? item.year,
      summary: asString(metadata.summary) ?? item.summary,
      rating: toNumber(metadata.rating) ?? item.rating,
      ratingImage: asString(metadata.ratingImage) ?? item.ratingImage,
      audienceRating: toNumber(metadata.audienceRating) ?? item.audienceRating,
      audienceRatingImage: asString(metadata.audienceRatingImage) ?? item.audienceRatingImage,
      thumb: asString(metadata.thumb) ?? item.thumb,
      art: asString(metadata.art) ?? item.art,
      durationMs: toNumber(metadata.duration) ?? item.durationMs,
      childCount: toNumber(metadata.childCount) ?? item.childCount,
      leafCount: toNumber(metadata.leafCount) ?? item.leafCount
    };
  }

  private applyUserState(
    item: PlexMediaItem,
    state: Record<string, unknown> | undefined
  ): PlexMediaItem {
    if (!state) {
      return item;
    }

    const watchlistedAt = toNumber(state.watchlistedAt);
    const watchlisted = Boolean(item.inWatchlist || (watchlistedAt && watchlistedAt > 0));
    const merged: PlexMediaItem = {
      ...item,
      viewCount: toNumber(state.viewCount) ?? item.viewCount,
      viewedLeafCount: toNumber(state.viewedLeafCount) ?? item.viewedLeafCount,
      leafCount: toNumber(state.leafCount) ?? item.leafCount,
      lastViewedAt: toNumber(state.lastViewedAt) ?? item.lastViewedAt,
      inWatchlist: watchlisted
    };

    if (merged.inWatchlist) {
      merged.libraryTitle = "Watchlist";
    } else if (typeof merged.viewCount === "number" && merged.viewCount > 0) {
      merged.libraryTitle = "Assistidos";
    }

    return merged;
  }

  private toMediaItem(
    node: Record<string, unknown>,
    libraryTitle: string
  ): PlexMediaItem | undefined {
    const ratingKey = asString(node.ratingKey);
    const title = asString(node.title);
    const type = asString(node.type);

    if (!ratingKey || !title || !type) {
      return undefined;
    }

    return {
      ratingKey,
      guid: asString(node.guid),
      type,
      title,
      originalTitle: asString(node.originalTitle),
      year: toNumber(node.year),
      summary: asString(node.summary),
      rating: toNumber(node.rating),
      ratingImage: asString(node.ratingImage),
      audienceRating: toNumber(node.audienceRating),
      audienceRatingImage: asString(node.audienceRatingImage),
      thumb: asString(node.thumb),
      art: asString(node.art),
      durationMs: toNumber(node.duration),
      viewCount: toNumber(node.viewCount),
      viewedLeafCount: toNumber(node.viewedLeafCount),
      leafCount: toNumber(node.leafCount),
      childCount: toNumber(node.childCount),
      lastViewedAt: toNumber(node.lastViewedAt),
      updatedAt: toNumber(node.updatedAt),
      libraryTitle,
      inWatchlist: libraryTitle === "Watchlist"
    };
  }

  private toSearchItem(node: Record<string, unknown>): PlexDiscoverSearchItem | undefined {
    const ratingKey = asString(node.ratingKey);
    const title = asString(node.title);
    const type = asString(node.type);

    if (!ratingKey || !title || !type) {
      return undefined;
    }

    return {
      ratingKey,
      guid: asString(node.guid),
      type,
      title,
      year: toNumber(node.year),
      originalTitle: asString(node.originalTitle)
    };
  }

  private async requestJson<T>(
    method: "GET" | "PUT",
    baseUrl: string,
    query: Record<string, string>,
    returnUndefinedOn404 = false
  ): Promise<T | undefined> {
    const response = await this.request(method, baseUrl, query);
    if (response.status === 404 && returnUndefinedOn404) {
      return undefined;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Erro Discover ${method} ${baseUrl}: status=${response.status} body=${truncate(response.text)}`
      );
    }

    try {
      return JSON.parse(response.text) as T;
    } catch (error) {
      throw new Error(`Falha ao parsear JSON de ${baseUrl}: ${error}`);
    }
  }

  private async request(
    method: "GET" | "PUT",
    baseUrl: string,
    query: Record<string, string>
  ): Promise<PlexHttpResponse> {
    const url = this.buildUrl(baseUrl, query);
    this.logger.debug(`Discover request ${method} ${maskTokenInUrl(url)}`);

    const response = await withTimeout(
      this.requestFn({
        url,
        method,
        headers: this.buildHeaders(),
        throw: false
      }),
      this.timeoutSeconds * 1000,
      `Timeout Discover ${method} ${baseUrl}`
    );

    return {
      status: response.status,
      text: response.text
    };
  }

  private buildUrl(baseUrl: string, query: Record<string, string>): string {
    const params = new URLSearchParams({
      ...query,
      "X-Plex-Token": this.accountToken
    });
    return `${baseUrl}?${params.toString()}`;
  }

  private buildHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      "X-Plex-Token": this.accountToken,
      "X-Plex-Client-Identifier": this.clientIdentifier,
      "X-Plex-Product": this.product,
      "X-Plex-Device-Name": this.product,
      "X-Plex-Language": "pt-BR",
      "Accept-Language": "pt-BR"
    };
  }
}

function toEpisodeInfo(node: Record<string, unknown>): PlexEpisodeInfo | undefined {
  const ratingKey = asString(node.ratingKey);
  const title = asString(node.title);
  if (!ratingKey || !title) {
    return undefined;
  }

  const viewCount = toNumber(node.viewCount);
  const watched = Boolean(viewCount && viewCount > 0);

  return {
    ratingKey,
    title,
    seasonNumber: toNumber(node.parentIndex),
    episodeNumber: toNumber(node.index),
    watched,
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

function ensureArrayOfRecords(value: unknown): Record<string, unknown>[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null
    );
  }
  if (typeof value === "object") {
    return [value as Record<string, unknown>];
  }
  return [];
}

function extractMetadata(entry: Record<string, unknown>): Record<string, unknown> {
  const metadata = entry.Metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return entry;
}

function truncate(text: string): string {
  const compact = (text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= 250) {
    return compact;
  }
  return `${compact.slice(0, 250)}...`;
}

function maskTokenInUrl(url: string): string {
  return url.replace(/X-Plex-Token=[^&]+/g, "X-Plex-Token=***");
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
