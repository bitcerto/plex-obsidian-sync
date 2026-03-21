import type { PlexSyncSettings } from "../types";

export const PLUGIN_ID = "plex-obsidian-sync";

export const MANAGED_KEYS = [
  "plex_rating_key",
  "plex_parent_rating_key",
  "plex_guid",
  "biblioteca",
  "tipo",
  "titulo",
  "serie_titulo",
  "serie_rating_key",
  "titulo_original",
  "ano",
  "temporada_numero",
  "episodio_numero",
  "resumo",
  "nota_critica",
  "nota_critica_fonte",
  "nota_publico",
  "nota_publico_fonte",
  "capa_url",
  "fundo_url",
  "duracao_minutos",
  "pausa",
  "temporadas",
  "episodios",
  "episodios_assistidos",
  "assistido",
  // Campos legados de watchlist: mantidos como managed apenas para limpeza automatica das notas antigas.
  "na_lista_para_assistir",
  "na_watchlist",
  "ultima_visualizacao_plex",
  "atualizado_plex_em",
  "sincronizado_em",
  "sincronizado_por",
  "minha_nota"
] as const;

export const SYNC_FIELDS = new Set<string>(["sincronizado_em", "sincronizado_por"]);

// Mapeia chaves internas (canonicas) para chaves externas no frontmatter.
// O plugin aceita aliases em portugues e ingles durante a leitura para manter compatibilidade.
const PROPERTY_KEY_ALIASES_PT_BR: Record<string, string> = {
  plex_rating_key: "plex rating key",
  plex_parent_rating_key: "plex parent rating key",
  plex_guid: "plex guid",
  biblioteca: "biblioteca",
  tipo: "tipo",
  titulo: "titulo",
  serie_titulo: "serie titulo",
  serie_rating_key: "serie rating key",
  titulo_original: "titulo original",
  ano: "ano",
  temporada_numero: "temporada numero",
  episodio_numero: "episodio numero",
  resumo: "resumo",
  nota_critica: "nota critica",
  nota_critica_fonte: "nota critica fonte",
  nota_publico: "nota publico",
  nota_publico_fonte: "nota publico fonte",
  capa_url: "capa url",
  fundo_url: "fundo url",
  duracao_minutos: "duracao minutos",
  pausa: "pausa",
  temporadas: "temporadas",
  episodios: "episodios",
  episodios_assistidos: "episodios assistidos",
  assistido: "assistido",
  na_lista_para_assistir: "na lista para assistir",
  na_watchlist: "na watchlist",
  ultima_visualizacao_plex: "ultima visualizacao plex",
  atualizado_plex_em: "atualizado plex em",
  sincronizado_em: "sincronizado em",
  sincronizado_por: "sincronizado por",
  minha_nota: "minha nota"
};

const PROPERTY_KEY_ALIASES_EN_US: Record<string, string> = {
  plex_rating_key: "plex rating key",
  plex_parent_rating_key: "plex parent rating key",
  plex_guid: "plex guid",
  biblioteca: "library",
  tipo: "type",
  titulo: "title",
  serie_titulo: "series title",
  serie_rating_key: "series rating key",
  titulo_original: "original title",
  ano: "year",
  temporada_numero: "season number",
  episodio_numero: "episode number",
  resumo: "summary",
  nota_critica: "critic rating",
  nota_critica_fonte: "critic rating source",
  nota_publico: "audience rating",
  nota_publico_fonte: "audience rating source",
  capa_url: "poster url",
  fundo_url: "background url",
  duracao_minutos: "duration minutes",
  pausa: "pause",
  temporadas: "seasons",
  episodios: "episodes",
  episodios_assistidos: "watched episodes",
  assistido: "watched",
  na_lista_para_assistir: "in watchlist",
  na_watchlist: "in watchlist legacy",
  ultima_visualizacao_plex: "last viewed at plex",
  atualizado_plex_em: "updated at plex",
  sincronizado_em: "synced at",
  sincronizado_por: "synced by",
  minha_nota: "my rating"
};

const LEGACY_PROPERTY_KEY_ALIASES_PT_BR: Record<string, string> = {
  plex_rating_key: "plex-rating-key",
  plex_parent_rating_key: "plex-parent-rating-key",
  plex_guid: "plex-guid",
  serie_titulo: "serie-titulo",
  serie_rating_key: "serie-rating-key",
  titulo_original: "titulo-original",
  temporada_numero: "temporada-numero",
  episodio_numero: "episodio-numero",
  nota_critica: "nota-critica",
  nota_critica_fonte: "nota-critica-fonte",
  nota_publico: "nota-publico",
  nota_publico_fonte: "nota-publico-fonte",
  capa_url: "capa-url",
  fundo_url: "fundo-url",
  duracao_minutos: "duracao-minutos",
  pausa: "pausa",
  episodios_assistidos: "episodios-assistidos",
  na_lista_para_assistir: "na-lista-para-assistir",
  na_watchlist: "na-watchlist",
  ultima_visualizacao_plex: "ultima-visualizacao-plex",
  atualizado_plex_em: "atualizado-plex-em",
  sincronizado_em: "sincronizado-em",
  sincronizado_por: "sincronizado-por"
};

const LEGACY_PROPERTY_KEY_ALIASES_EN_US: Record<string, string> = {
  plex_rating_key: "plex-rating-key",
  plex_parent_rating_key: "plex-parent-rating-key",
  plex_guid: "plex-guid",
  serie_titulo: "series-title",
  serie_rating_key: "series-rating-key",
  titulo_original: "original-title",
  temporada_numero: "season-number",
  episodio_numero: "episode-number",
  nota_critica: "critic-rating",
  nota_critica_fonte: "critic-rating-source",
  nota_publico: "audience-rating",
  nota_publico_fonte: "audience-rating-source",
  capa_url: "poster-url",
  fundo_url: "background-url",
  duracao_minutos: "duration-minutes",
  pausa: "pause",
  episodios_assistidos: "watched-episodes",
  na_lista_para_assistir: "in-watchlist",
  na_watchlist: "in-watchlist-legacy",
  ultima_visualizacao_plex: "last-viewed-at-plex",
  atualizado_plex_em: "updated-at-plex",
  sincronizado_em: "synced-at",
  sincronizado_por: "synced-by"
};

const PROPERTY_KEY_ALIASES_BY_LANGUAGE = {
  pt_br: PROPERTY_KEY_ALIASES_PT_BR,
  en_us: PROPERTY_KEY_ALIASES_EN_US
} as const;

const PROPERTY_KEY_ALIASES_REVERSE_PT_BR: Record<string, string> = Object.fromEntries(
  Object.entries(PROPERTY_KEY_ALIASES_PT_BR).map(([canonical, external]) => [external, canonical])
);

const PROPERTY_KEY_ALIASES_REVERSE_EN_US: Record<string, string> = Object.fromEntries(
  Object.entries(PROPERTY_KEY_ALIASES_EN_US).map(([canonical, external]) => [external, canonical])
);

const PROPERTY_KEY_ALIASES_REVERSE_LEGACY_PT_BR: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_PROPERTY_KEY_ALIASES_PT_BR).map(([canonical, external]) => [
    external,
    canonical
  ])
);

const PROPERTY_KEY_ALIASES_REVERSE_LEGACY_EN_US: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_PROPERTY_KEY_ALIASES_EN_US).map(([canonical, external]) => [
    external,
    canonical
  ])
);

export const PROPERTY_KEY_ALIASES_REVERSE: Record<string, string> = {
  ...PROPERTY_KEY_ALIASES_REVERSE_PT_BR,
  ...PROPERTY_KEY_ALIASES_REVERSE_EN_US,
  ...PROPERTY_KEY_ALIASES_REVERSE_LEGACY_PT_BR,
  ...PROPERTY_KEY_ALIASES_REVERSE_LEGACY_EN_US
};

export function resolveFrontmatterAliasLanguage(
  mode: PlexSyncSettings["frontmatterKeyLanguage"],
  obsidianLocale: string,
  plexLocale: string
): "pt_br" | "en_us" {
  if (mode === "pt_br" || mode === "en_us") {
    return mode;
  }
  const localeCandidate =
    typeof obsidianLocale === "string" && obsidianLocale.trim().length > 0
      ? obsidianLocale
      : plexLocale;
  if (typeof localeCandidate === "string" && localeCandidate.trim().toLowerCase().startsWith("pt")) {
    return "pt_br";
  }
  return "en_us";
}

export function getPropertyAliases(
  settings: Pick<PlexSyncSettings, "frontmatterKeyLanguage" | "obsidianLocale" | "plexAccountLocale">
): Record<string, string> {
  const language = resolveFrontmatterAliasLanguage(
    settings.frontmatterKeyLanguage,
    settings.obsidianLocale,
    settings.plexAccountLocale
  );
  return PROPERTY_KEY_ALIASES_BY_LANGUAGE[language];
}

export const TECH_FILES = {
  state: ".plex-obsidian-state.json",
  lock: ".plex-obsidian-lock.json",
  report: ".plex-obsidian-last-report.json",
  serversCache: ".plex-servers-cache.json"
} as const;

export const DEFAULT_SETTINGS: PlexSyncSettings = {
  authMode: "hybrid_account",
  plexAccountToken: "",
  plexAccountEmail: "",
  plexAccountLocale: "",
  obsidianLocale: "",
  plexClientIdentifier: "",
  selectedServerMachineId: "",
  connectionStrategy: "remote_first",
  serversCache: [],

  plexBaseUrl: "",
  plexToken: "",
  libraries: [],
  notesFolder: "Media-Plex",
  conflictPolicy: "latest",
  frontmatterKeyLanguage: "auto_obsidian",
  autoSyncEnabled: false,
  syncIntervalSeconds: 60,
  syncOnStartup: true,
  startupDelaySeconds: 15,
  syncOnlyWhenOnline: true,
  lockTtlSeconds: 120,
  requestTimeoutSeconds: 20,
  debugLogs: false
};
