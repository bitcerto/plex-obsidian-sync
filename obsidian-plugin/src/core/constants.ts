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
  "sincronizado_por"
] as const;

export const SYNC_FIELDS = new Set<string>(["sincronizado_em", "sincronizado_por"]);

export const TECH_FILES = {
  state: ".plex-obsidian-state.json",
  lock: ".plex-obsidian-lock.json",
  report: ".plex-obsidian-last-report.json",
  serversCache: ".plex-servers-cache.json"
} as const;

export const DEFAULT_SETTINGS: PlexSyncSettings = {
  authMode: "hybrid_account",
  plexAccountToken: "",
  plexClientIdentifier: "",
  selectedServerMachineId: "",
  connectionStrategy: "remote_first",
  serversCache: [],

  plexBaseUrl: "",
  plexToken: "",
  libraries: [],
  notesFolder: "Media-Plex",
  conflictPolicy: "latest",
  syncIntervalSeconds: 60,
  syncOnStartup: true,
  startupDelaySeconds: 15,
  syncOnlyWhenOnline: true,
  lockTtlSeconds: 120,
  requestTimeoutSeconds: 20,
  debugLogs: false
};
