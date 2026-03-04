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
const ACCOUNT_PAGE_SIZE = 100;
const WATCHED_HISTORY_ENDPOINTS = [
  `${DISCOVER_BASE}/library/sections/history/all`,
  `${DISCOVER_BASE}/library/history/all`,
  `${DISCOVER_BASE}/library/sections/history`
] as const;

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
    const listed = await this.listSectionItems(
      `${DISCOVER_BASE}/library/sections/watchlist/all`,
      {
        type: "99",
        sort: "watchlistedAt:desc",
        includeUserState: "1",
        includeCollections: "1",
        includeExternalMedia: "1"
      },
      "Watchlist"
    );

    return listed.items;
  }

  async listWatchedHistory(sinceViewedAt?: number): Promise<PlexMediaItem[]> {
    for (const endpoint of WATCHED_HISTORY_ENDPOINTS) {
      try {
        const listed = await this.listWatchedHistoryItems(
          endpoint,
          {
            type: "99",
            sort: "viewedAt:desc",
            includeUserState: "1",
            includeCollections: "1",
            includeExternalMedia: "1"
          },
          "Assistidos",
          sinceViewedAt
        );

        if (!listed.supported) {
          continue;
        }

        return listed.items;
      } catch (error) {
        this.logger.debug("falha ao carregar histórico assistido da conta", {
          endpoint,
          error: String(error)
        });
      }
    }

    this.logger.warn(
      "Não foi possível carregar histórico assistido da conta via Discover. Seguindo somente com watchlist."
    );
    return [];
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

    const enriched = await Promise.all(
      Array.from(dedup.values()).map(async (item) => {
        const hasSummary = typeof item.summary === "string" && item.summary.trim().length > 0;
        if (hasSummary) {
          return item;
        }

        try {
          const metadata = await this.getMetadataDetails(item.ratingKey);
          if (!metadata) {
            return item;
          }
          return this.applySearchMetadata(item, metadata);
        } catch (error) {
          this.logger.debug("falha ao enriquecer item de busca", {
            ratingKey: item.ratingKey,
            error: String(error)
          });
          return item;
        }
      })
    );

    return enriched;
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

    return this.enrichMediaItem(item);
  }

  async markWatched(ratingKey: string, watched: boolean): Promise<void> {
    const action = watched ? "scrobble" : "unscrobble";
    const paramsCandidates = buildWatchedActionParamCandidates(ratingKey);

    for (const params of paramsCandidates) {
      await this.requestJson(
        "PUT",
        `${DISCOVER_BASE}/actions/${action}`,
        params,
        false
      );

      const confirmed = await this.confirmWatchedState(ratingKey, watched);
      if (confirmed === true || confirmed === undefined) {
        return;
      }
    }

    throw new Error(
      `Plex Discover não confirmou alteração de assistido para ratingKey=${ratingKey}`
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

  private async confirmWatchedState(
    ratingKey: string,
    expectedWatched: boolean
  ): Promise<boolean | undefined> {
    let sawKnownState = false;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      let state: Record<string, unknown> | undefined;
      try {
        state = await this.getUserState(ratingKey);
      } catch {
        state = undefined;
      }

      const watchedState = inferWatchedFromUserState(state);
      if (typeof watchedState === "boolean") {
        sawKnownState = true;
        if (watchedState === expectedWatched) {
          return true;
        }
      }

      if (attempt < 3) {
        await sleep(250);
      }
    }

    if (!sawKnownState) {
      // Nem todo conteúdo expõe estado completo via endpoint.
      return undefined;
    }
    return false;
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

  private async listSectionItems(
    endpoint: string,
    query: Record<string, string>,
    libraryTitle: string,
    allow404 = false
  ): Promise<{ supported: boolean; items: PlexMediaItem[] }> {
    const rawItems: Record<string, unknown>[] = [];
    let start = 0;

    while (true) {
      const response = await this.requestJson<DiscoverListResponse>(
        "GET",
        endpoint,
        {
          ...query,
          "X-Plex-Container-Start": String(start),
          "X-Plex-Container-Size": String(ACCOUNT_PAGE_SIZE)
        },
        allow404
      );

      if (!response) {
        if (start === 0 && allow404) {
          return { supported: false, items: [] };
        }
        break;
      }

      const media = response.MediaContainer;
      const pageItems = ensureArrayOfRecords(media?.Metadata);
      rawItems.push(...pageItems);

      const reportedSize = toNumber(media?.size) ?? pageItems.length;
      if (reportedSize <= 0) {
        break;
      }

      start += reportedSize;

      const reportedTotal = toNumber(media?.totalSize);
      if (typeof reportedTotal === "number" && start >= reportedTotal) {
        break;
      }
      if (typeof reportedTotal !== "number" && reportedSize < ACCOUNT_PAGE_SIZE) {
        break;
      }
    }

    const items = rawItems
      .map((node) => this.toMediaItem(node, libraryTitle))
      .filter((entry): entry is PlexMediaItem => entry !== undefined);

    return { supported: true, items };
  }

  private async listWatchedHistoryItems(
    endpoint: string,
    query: Record<string, string>,
    libraryTitle: string,
    sinceViewedAt?: number
  ): Promise<{ supported: boolean; items: PlexMediaItem[] }> {
    const rawItems: Record<string, unknown>[] = [];
    let start = 0;
    let pageIndex = 0;
    const hasCutoff = typeof sinceViewedAt === "number" && Number.isFinite(sinceViewedAt);
    const maxPagesWithCutoff = 3;

    while (true) {
      const response = await this.requestJson<DiscoverListResponse>(
        "GET",
        endpoint,
        {
          ...query,
          "X-Plex-Container-Start": String(start),
          "X-Plex-Container-Size": String(ACCOUNT_PAGE_SIZE)
        },
        true
      );

      if (!response) {
        if (start === 0) {
          return { supported: false, items: [] };
        }
        break;
      }

      const media = response.MediaContainer;
      const pageNodes = ensureArrayOfRecords(media?.Metadata);
      rawItems.push(...pageNodes);

      const reportedSize = toNumber(media?.size) ?? pageNodes.length;
      if (reportedSize <= 0) {
        break;
      }

      const pageItems = pageNodes
        .map((node) => this.toMediaItem(node, libraryTitle))
        .filter((entry): entry is PlexMediaItem => entry !== undefined);
      const reachedKnownBoundary =
        hasCutoff &&
        pageItems.length > 0 &&
        pageItems.every((entry) => {
          const lastViewedAt = typeof entry.lastViewedAt === "number" ? entry.lastViewedAt : 0;
          return lastViewedAt <= (sinceViewedAt as number);
        });
      if (reachedKnownBoundary) {
        break;
      }

      pageIndex += 1;
      if (hasCutoff && pageIndex >= maxPagesWithCutoff) {
        break;
      }

      start += reportedSize;

      const reportedTotal = toNumber(media?.totalSize);
      if (typeof reportedTotal === "number" && start >= reportedTotal) {
        break;
      }
      if (typeof reportedTotal !== "number" && reportedSize < ACCOUNT_PAGE_SIZE) {
        break;
      }
    }

    const items = rawItems
      .map((node) => this.toMediaItem(node, libraryTitle))
      .filter((entry): entry is PlexMediaItem => entry !== undefined);

    return { supported: true, items };
  }

  private async enrichMediaItem(item: PlexMediaItem): Promise<PlexMediaItem> {
    const metadata = await this.getMetadataDetails(item.ratingKey);
    const state = await this.getUserState(item.ratingKey);
    const withMetadata = this.applyMetadata(item, metadata);
    return this.applyUserState(withMetadata, state);
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

  private applySearchMetadata(
    item: PlexDiscoverSearchItem,
    metadata: Record<string, unknown>
  ): PlexDiscoverSearchItem {
    return {
      ...item,
      title: asString(metadata.title) ?? item.title,
      originalTitle: asString(metadata.originalTitle) ?? item.originalTitle,
      year: toNumber(metadata.year) ?? item.year,
      summary: asString(metadata.summary) ?? asString(metadata.tagline) ?? item.summary,
      thumb: asString(metadata.thumb) ?? item.thumb,
      art: asString(metadata.art) ?? item.art
    };
  }

  private toMediaItem(
    node: Record<string, unknown>,
    libraryTitle: string
  ): PlexMediaItem | undefined {
    const type = asString(node.type);
    if (type === "episode") {
      return this.toShowFromEpisode(node, libraryTitle);
    }

    const ratingKey = asString(node.ratingKey);
    const title = asString(node.title);

    if (!ratingKey || !title || !type || (type !== "movie" && type !== "show")) {
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

  private toShowFromEpisode(
    node: Record<string, unknown>,
    libraryTitle: string
  ): PlexMediaItem | undefined {
    const showRatingKey = asString(node.grandparentRatingKey);
    const showTitle = asString(node.grandparentTitle);
    if (!showRatingKey || !showTitle) {
      return undefined;
    }

    return {
      ratingKey: showRatingKey,
      guid: asString(node.grandparentGuid) ?? asString(node.guid),
      type: "show",
      title: showTitle,
      originalTitle: asString(node.grandparentOriginalTitle) ?? asString(node.originalTitle),
      year: toNumber(node.grandparentYear) ?? toNumber(node.year),
      summary: asString(node.grandparentSummary) ?? asString(node.summary),
      rating: toNumber(node.rating),
      ratingImage: asString(node.ratingImage),
      audienceRating: toNumber(node.audienceRating),
      audienceRatingImage: asString(node.audienceRatingImage),
      thumb: asString(node.grandparentThumb) ?? asString(node.thumb),
      art: asString(node.grandparentArt) ?? asString(node.art),
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
      originalTitle: asString(node.originalTitle),
      summary: asString(node.summary),
      thumb: asString(node.thumb),
      art: asString(node.art)
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
    const first = await this.requestOnce(method, baseUrl, query, false);
    if (first.status === 401 || first.status === 403) {
      return this.requestOnce(method, baseUrl, query, true);
    }
    return first;
  }

  private async requestOnce(
    method: "GET" | "PUT",
    baseUrl: string,
    query: Record<string, string>,
    includeTokenInQuery: boolean
  ): Promise<PlexHttpResponse> {
    const url = this.buildUrl(baseUrl, query, includeTokenInQuery);
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

  private buildUrl(
    baseUrl: string,
    query: Record<string, string>,
    includeTokenInQuery: boolean
  ): string {
    const params = new URLSearchParams({
      ...query
    });
    if (includeTokenInQuery) {
      params.set("X-Plex-Token", this.accountToken);
    }
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

function buildWatchedActionParamCandidates(ratingKey: string): Array<Record<string, string>> {
  const variants: Array<Record<string, string>> = [
    { key: ratingKey },
    { ratingKey },
    { identifier: ratingKey },
    { key: ratingKey, ratingKey }
  ];

  const unique = new Set<string>();
  const result: Array<Record<string, string>> = [];
  for (const entry of variants) {
    const normalized = Object.keys(entry)
      .sort()
      .map((key) => `${key}=${entry[key]}`)
      .join("&");
    if (unique.has(normalized)) {
      continue;
    }
    unique.add(normalized);
    result.push(entry);
  }
  return result;
}

function inferWatchedFromUserState(state: Record<string, unknown> | undefined): boolean | undefined {
  if (!state) {
    return undefined;
  }

  const viewCount = toNumber(state.viewCount);
  if (typeof viewCount === "number") {
    return viewCount > 0;
  }

  const lastViewedAt = toNumber(state.lastViewedAt);
  if (typeof lastViewedAt === "number" && lastViewedAt > 0) {
    return true;
  }

  const viewedLeafCount = toNumber(state.viewedLeafCount);
  const leafCount = toNumber(state.leafCount);
  if (
    typeof viewedLeafCount === "number" &&
    typeof leafCount === "number" &&
    leafCount > 0
  ) {
    return viewedLeafCount >= leafCount;
  }

  return undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
