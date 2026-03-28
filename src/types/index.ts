export type ConflictPolicy = "latest" | "plex" | "obsidian";
export type AuthMode = "hybrid_account" | "account_only" | "manual";
export type ConnectionStrategy = "remote_first" | "local_first" | "local_only";
export type FrontmatterKeyLanguage = "auto_obsidian" | "pt_br" | "en_us";

export interface PlexConnection {
  uri: string;
  local: boolean;
  protocol?: string;
  address?: string;
  port?: number;
  relay?: boolean;
  ipv6?: boolean;
}

export interface PlexAccountServer {
  machineId: string;
  name: string;
  accessToken?: string;
  sourceTitle?: string;
  owned?: boolean;
  provides: string[];
  connections: PlexConnection[];
  updatedAt?: string;
}

export interface PlexPinSession {
  id: number;
  code: string;
  authUrl: string;
  expiresAt?: number;
  createdAt: number;
}

export interface PlexDiscoverSearchItem {
  ratingKey: string;
  guid?: string;
  type: string;
  title: string;
  year?: number;
  originalTitle?: string;
  summary?: string;
  thumb?: string;
  art?: string;
}

export interface PlexSyncSettings {
  authMode: AuthMode;
  plexAccountToken: string;
  plexAccountEmail: string;
  plexAccountLocale: string;
  obsidianLocale: string;
  plexClientIdentifier: string;
  selectedServerMachineId: string;
  connectionStrategy: ConnectionStrategy;
  serversCache: PlexAccountServer[];

  plexBaseUrl: string;
  plexToken: string;
  libraries: string[];
  notesFolder: string;
  conflictPolicy: ConflictPolicy;
  frontmatterKeyLanguage: FrontmatterKeyLanguage;
  autoSyncEnabled: boolean;
  syncIntervalSeconds: number;
  syncOnStartup: boolean;
  startupDelaySeconds: number;
  syncOnlyWhenOnline: boolean;
  lockTtlSeconds: number;
  requestTimeoutSeconds: number;
  debugLogs: boolean;
}

export interface PlexSection {
  key: string;
  title: string;
  type: string;
}

export interface PlexMediaItem {
  ratingKey: string;
  guid?: string;
  type: string;
  title: string;
  originalTitle?: string;
  year?: number;
  summary?: string;
  rating?: number;
  ratingImage?: string;
  audienceRating?: number;
  audienceRatingImage?: string;
  thumb?: string;
  art?: string;
  durationMs?: number;
  viewCount?: number;
  viewedLeafCount?: number;
  leafCount?: number;
  childCount?: number;
  lastViewedAt?: number;
  updatedAt?: number;
  libraryTitle: string;
  inWatchlist?: boolean;
  seasons?: PlexSeasonInfo[];
}

export interface PlexSeasonInfo {
  ratingKey: string;
  title: string;
  seasonNumber?: number;
  episodeCount?: number;
  watchedEpisodeCount?: number;
  summary?: string;
  rating?: number;
  ratingImage?: string;
  audienceRating?: number;
  audienceRatingImage?: string;
  thumb?: string;
  art?: string;
  episodes: PlexEpisodeInfo[];
}

export interface PlexEpisodeInfo {
  ratingKey: string;
  title: string;
  seasonNumber?: number;
  episodeNumber?: number;
  watched: boolean;
  durationMs?: number;
  summary?: string;
}

export interface ManagedFrontmatter {
  plex_rating_key: string;
  plex_parent_rating_key?: string;
  plex_guid?: string;
  biblioteca: string;
  tipo?: string;
  titulo?: string;
  serie_titulo?: string;
  serie_rating_key?: string;
  titulo_original?: string;
  ano?: number;
  temporada_numero?: number;
  episodio_numero?: number;
  resumo?: string;
  nota_critica?: number;
  nota_critica_fonte?: string;
  nota_publico?: number;
  nota_publico_fonte?: string;
  capa_url?: string;
  fundo_url?: string;
  duracao_minutos?: number;
  pausa?: string;
  temporadas?: number;
  episodios?: number;
  episodios_assistidos?: number;
  assistido: boolean;
  na_lista_para_assistir?: boolean;
  ultima_visualizacao_plex?: string;
  atualizado_plex_em?: string;
  sincronizado_em?: string;
  sincronizado_por?: string;
  minha_nota?: number | string;
}

export interface NoteData {
  exists: boolean;
  path: string;
  content: string;
  body: string;
  frontmatter: Record<string, unknown>;
  mtimeMs: number;
}

export interface SyncItemState {
  notePath: string;
  plexWatched: boolean;
  obsidianWatched: boolean;
  plexWatchlisted?: boolean;
  obsidianWatchlisted?: boolean;
  plexUpdatedAt?: number;
  plexLastViewedAt?: number;
  lastSyncAt: string;
  lastSyncEpoch: number;
}

export interface SyncStateFile {
  version: number;
  items: Record<string, SyncItemState>;
  lastRunAt?: string;
}

export interface SyncLockFile {
  deviceId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  reason: string;
  skipped?: string;
  totalItems: number;
  createdNotes: number;
  updatedNotes: number;
  updatedPlex: number;
  conflicts: number;
  errors: string[];
  deviceId: string;
  lockOwner?: string;
  resolvedServer?: string;
  resolvedConnectionUri?: string;
}

export interface SyncOptions {
  reason: string;
  forceFullRebuild?: boolean;
  preferredObsidianKeys?: string[];
  preferredObsidianWatchedByKey?: Record<string, boolean>;
  targetRatingKeys?: string[];
  deletedRatingKeys?: string[];
  overrideSeasonRatingKeys?: Set<string>;
  overrideEpisodeRatingKeys?: Set<string>;
  overrideSeasonWatchedByKey?: Map<string, boolean>;
  overrideEpisodeWatchedByKey?: Map<string, boolean>;
  overrideSeasonCheckboxSnapshotsByKey?: Map<string, string>;
}

export interface SyncExecutionResult {
  report: SyncReport;
  skipped: boolean;
}
