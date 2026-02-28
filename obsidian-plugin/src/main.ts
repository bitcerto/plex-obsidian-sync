import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, PLUGIN_ID } from "./core/constants";
import { ensureMinNumber } from "./core/utils";
import { PlexDiscoverClient } from "./services/plex-discover-client";
import { Logger } from "./services/logger";
import { SyncEngine } from "./services/sync-engine";
import { PlexTvClient } from "./services/plex-tv-client";
import type { PlexDiscoverSearchItem, PlexSyncSettings, SyncReport } from "./types";
import { DiscoverSearchModal } from "./ui/discover-search-modal";
import { ReportModal } from "./ui/report-modal";
import { PlexSyncSettingTab } from "./ui/settings-tab";

const PRODUCT_NAME = "Plex Obsidian Sync";
const LOCAL_DEVICE_ID_KEY = "plex-obsidian-sync.local-device-id";

export default class PlexObsidianSyncPlugin extends Plugin {
  settings: PlexSyncSettings = { ...DEFAULT_SETTINGS };

  private logger = new Logger(false);
  private engine?: SyncEngine;
  private statusBar?: HTMLElement;
  private startupTimer: number | null = null;
  private intervalTimer: number | null = null;
  private loginInProgress = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.logger.setDebugEnabled(this.settings.debugLogs);
    this.statusBar = this.addStatusBarItem();
    this.setStatus("Plex Sync: loaded");

    const localDeviceId = getOrCreateLocalDeviceId();
    this.engine = new SyncEngine(
      this.app,
      () => this.settings,
      this.logger,
      (text) => this.setStatus(text),
      localDeviceId
    );

    this.addSettingTab(new PlexSyncSettingTab(this.app, this));
    this.registerCommands();
    this.scheduleSyncJobs();

    this.logger.info(`${PLUGIN_ID} carregado`);
  }

  onunload(): void {
    this.clearScheduledJobs();
    this.setStatus("Plex Sync: unloaded");
  }

  async saveSettings(): Promise<void> {
    this.settings.autoSyncEnabled = Boolean(this.settings.autoSyncEnabled);
    this.settings.obsidianLocale = detectObsidianLocale();
    this.settings.syncIntervalSeconds = this.settings.autoSyncEnabled
      ? ensureMinNumber(this.settings.syncIntervalSeconds, 30)
      : Math.max(0, Math.floor(Number(this.settings.syncIntervalSeconds) || 0));
    this.settings.startupDelaySeconds = Math.max(0, Math.floor(this.settings.startupDelaySeconds));
    this.settings.lockTtlSeconds = ensureMinNumber(this.settings.lockTtlSeconds, 30);
    this.settings.requestTimeoutSeconds = ensureMinNumber(this.settings.requestTimeoutSeconds, 5);

    if ((this.settings.frontmatterKeyLanguage as unknown as string) === "auto_plex") {
      this.settings.frontmatterKeyLanguage = "auto_obsidian";
    }
    if (
      this.settings.frontmatterKeyLanguage !== "auto_obsidian" &&
      this.settings.frontmatterKeyLanguage !== "pt_br" &&
      this.settings.frontmatterKeyLanguage !== "en_us"
    ) {
      this.settings.frontmatterKeyLanguage = "auto_obsidian";
    }
    if (typeof this.settings.plexAccountLocale !== "string") {
      this.settings.plexAccountLocale = "";
    }
    if (typeof this.settings.obsidianLocale !== "string") {
      this.settings.obsidianLocale = detectObsidianLocale();
    }

    if (!Array.isArray(this.settings.libraries)) {
      this.settings.libraries = [];
    }
    if (!Array.isArray(this.settings.serversCache)) {
      this.settings.serversCache = [];
    }

    if (!this.settings.plexClientIdentifier) {
      this.settings.plexClientIdentifier = generateClientIdentifier();
    }

    await this.saveData(this.settings);
    this.logger.setDebugEnabled(this.settings.debugLogs);
    this.scheduleSyncJobs();

    if (this.engine) {
      await this.engine.writeServersCache();
    }
  }

  async loginWithPlexAccount(): Promise<void> {
    if (this.loginInProgress) {
      new Notice("Plex Sync: login ja em andamento");
      return;
    }

    this.loginInProgress = true;
    try {
      if (this.settings.authMode === "manual") {
        this.settings.authMode = "hybrid_account";
      }
      if (!this.settings.plexClientIdentifier) {
        this.settings.plexClientIdentifier = generateClientIdentifier();
      }
      await this.saveSettings();

      const client = this.createPlexTvClient();
      const pin = await client.createPinSession();

      const opened = window.open(pin.authUrl, "_blank");
      if (!opened) {
        new Notice("Plex Sync: nao foi possivel abrir o navegador automaticamente");
      }

      new Notice("Plex Sync: conclua o login na pagina Plex aberta. Aguardando autorizacao...", 8000);
      this.setStatus("Plex Sync: aguardando login Plex...");

      const token = await this.waitForPinAuth(client, pin);
      if (!token) {
        throw new Error("tempo esgotado aguardando autorizacao do PIN");
      }

      const user = await client.validateUser(token);
      this.settings.plexAccountToken = token;
      const locale = extractLocaleFromUser(user);
      if (locale) {
        this.settings.plexAccountLocale = locale;
      }
      await this.saveSettings();

      new Notice("Plex Sync: login da conta Plex concluido", 5000);
      if (this.settings.authMode === "hybrid_account") {
        await this.refreshPlexServers();
      }
    } catch (error) {
      new Notice(`Plex Sync login falhou: ${String(error)}`, 7000);
      this.logger.error("falha login conta Plex", error);
    } finally {
      this.loginInProgress = false;
      this.setStatus("Plex Sync: idle");
    }
  }

  async refreshPlexServers(): Promise<void> {
    try {
      if (!this.settings.plexAccountToken.trim()) {
        new Notice("Plex Sync: faca login com a conta Plex antes de atualizar servidores");
        return;
      }

      if (!this.settings.plexClientIdentifier) {
        this.settings.plexClientIdentifier = generateClientIdentifier();
      }

      const client = this.createPlexTvClient();
      const servers = await client.listServers(this.settings.plexAccountToken);

      this.settings.serversCache = servers;

      if (
        this.settings.selectedServerMachineId &&
        !servers.some((entry) => entry.machineId === this.settings.selectedServerMachineId)
      ) {
        this.settings.selectedServerMachineId = "";
      }

      await this.saveSettings();
      if (servers.length === 0) {
        if (this.settings.authMode === "account_only") {
          new Notice("Plex Sync: conta conectada. Sem servidores e esperado no modo conta sem PMS.", 7000);
          return;
        }
        new Notice(
          "Plex Sync: 0 servidores encontrados nesta conta Plex. Verifique se o PMS esta vinculado a esta conta (ou compartilhado para ela), ou use modo manual.",
          10000
        );
      } else {
        new Notice(`Plex Sync: ${servers.length} servidor(es) encontrado(s)`);
      }
    } catch (error) {
      new Notice(`Plex Sync refresh falhou: ${String(error)}`, 7000);
      this.logger.error("falha refresh servidores", error);
    }
  }

  async logoutPlexAccount(): Promise<void> {
    this.settings.plexAccountToken = "";
    this.settings.selectedServerMachineId = "";
    this.settings.serversCache = [];
    await this.saveSettings();
    new Notice("Plex Sync: conta Plex desconectada");
  }

  private async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<PlexSyncSettings> | null;

    const migratedAuthMode = inferAuthMode(raw);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(raw || {}),
      authMode: migratedAuthMode
    };

    if (!Array.isArray(this.settings.libraries)) {
      this.settings.libraries = [];
    }

    if (!Array.isArray(this.settings.serversCache)) {
      this.settings.serversCache = [];
    }

    if (typeof this.settings.autoSyncEnabled !== "boolean") {
      this.settings.autoSyncEnabled = false;
    }
    if ((this.settings.frontmatterKeyLanguage as unknown as string) === "auto_plex") {
      this.settings.frontmatterKeyLanguage = "auto_obsidian";
    }
    if (
      this.settings.frontmatterKeyLanguage !== "auto_obsidian" &&
      this.settings.frontmatterKeyLanguage !== "pt_br" &&
      this.settings.frontmatterKeyLanguage !== "en_us"
    ) {
      this.settings.frontmatterKeyLanguage = "auto_obsidian";
    }
    if (typeof this.settings.plexAccountLocale !== "string") {
      this.settings.plexAccountLocale = "";
    }
    if (typeof this.settings.obsidianLocale !== "string" || !this.settings.obsidianLocale.trim()) {
      this.settings.obsidianLocale = detectObsidianLocale();
    }

    if (this.settings.notesFolder === "Media/Plex") {
      this.settings.notesFolder = "Media-Plex";
    }

    if (!this.settings.plexClientIdentifier) {
      this.settings.plexClientIdentifier = generateClientIdentifier();
    }

    await this.saveData(this.settings);
  }

  private registerCommands(): void {
    this.addCommand({
      id: "plex-sync-login-with-plex-account",
      name: "Plex Sync: Login with Plex Account",
      callback: () => {
        void this.loginWithPlexAccount();
      }
    });

    this.addCommand({
      id: "plex-sync-refresh-plex-servers",
      name: "Plex Sync: Refresh Plex Servers",
      callback: () => {
        void this.refreshPlexServers();
      }
    });

    this.addCommand({
      id: "plex-sync-now",
      name: "Plex Sync: Sync Now",
      callback: () => {
        void this.executeSync("manual");
      }
    });

    this.addCommand({
      id: "plex-sync-force-full-rebuild",
      name: "Plex Sync: Force Full Rebuild",
      callback: () => {
        void this.executeSync("force-full-rebuild", true);
      }
    });

    this.addCommand({
      id: "plex-sync-reset-local-state",
      name: "Plex Sync: Reset Local State",
      callback: () => {
        void this.resetLocalState();
      }
    });

    this.addCommand({
      id: "plex-sync-show-last-report",
      name: "Plex Sync: Show Last Sync Report",
      callback: () => {
        void this.showLastReport();
      }
    });

    this.addCommand({
      id: "plex-sync-search-add-watchlist",
      name: "Plex Sync: Search and Add to Watchlist",
      callback: () => {
        void this.openDiscoverSearchModal();
      }
    });

    this.addCommand({
      id: "plex-sync-logout-plex-account",
      name: "Plex Sync: Logout Plex Account",
      callback: () => {
        void this.logoutPlexAccount();
      }
    });
  }

  private scheduleSyncJobs(): void {
    this.clearScheduledJobs();

    if (!this.settings.autoSyncEnabled) {
      this.setStatus("Plex Sync: modo manual (Sync Now)");
      return;
    }

    if (this.settings.syncOnStartup) {
      const startupDelay = Math.max(0, Math.floor(this.settings.startupDelaySeconds));
      this.startupTimer = window.setTimeout(() => {
        if (!this.canRunSync("startup")) {
          return;
        }
        void this.executeSync("startup");
      }, startupDelay * 1000);
    }

    const intervalSec = ensureMinNumber(this.settings.syncIntervalSeconds, 30);
    this.intervalTimer = window.setInterval(() => {
      void this.executeSync("interval");
    }, intervalSec * 1000);
  }

  getResolvedFrontmatterLanguageLabel(): string {
    if (this.settings.frontmatterKeyLanguage === "pt_br") {
      return "pt-BR";
    }
    if (this.settings.frontmatterKeyLanguage === "en_us") {
      return "en-US";
    }
    const locale = this.settings.obsidianLocale.trim();
    if (locale.length > 0) {
      return locale;
    }
    return "en-US (fallback)";
  }

  private clearScheduledJobs(): void {
    if (this.startupTimer !== null) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    if (this.intervalTimer !== null) {
      window.clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private async executeSync(reason: string, forceFullRebuild = false): Promise<{
    report: SyncReport;
    skipped: boolean;
  } | null> {
    if (!this.engine) {
      new Notice("Plex Sync: engine nao inicializado");
      return null;
    }

    if (!this.canRunSync(reason)) {
      return null;
    }

    const result = await this.engine.runSync({
      reason,
      forceFullRebuild
    });

    this.handleReport(result.report, result.skipped);
    return result;
  }

  private handleReport(report: SyncReport, skipped: boolean): void {
    if (skipped && report.skipped) {
      new Notice(`Plex Sync: ${report.skipped}`);
      this.setStatus(`Plex Sync: ${report.skipped}`);
      return;
    }

    if (report.errors.length > 0) {
      new Notice(
        `Plex Sync com erros: itens=${report.totalItems}, erros=${report.errors.length}`,
        6000
      );
    } else {
      new Notice(
        `Plex Sync concluido: itens=${report.totalItems}, notas+${report.createdNotes}, atualizacoes=${report.updatedNotes}`,
        5000
      );
    }

    this.setStatus(
      `Plex Sync: ${report.totalItems} itens | notas+${report.createdNotes} | Plex+${report.updatedPlex}`
    );
  }

  private async resetLocalState(): Promise<void> {
    if (!this.engine) {
      return;
    }
    await this.engine.resetState();
    new Notice("Plex Sync: estado local removido");
  }

  private async showLastReport(): Promise<void> {
    if (!this.engine) {
      return;
    }

    const report = await this.engine.readLastReport();
    if (!report) {
      new Notice("Plex Sync: nenhum relatorio encontrado");
      return;
    }

    new ReportModal(this.app, report).open();
  }

  private async openDiscoverSearchModal(): Promise<void> {
    if (this.settings.authMode !== "account_only") {
      new Notice("Use o modo 'Conta Plex (sem servidor)' para buscar e adicionar via conta.");
      return;
    }

    if (!this.settings.plexAccountToken.trim()) {
      new Notice("Plex Sync: faca login com a conta Plex antes de buscar.");
      return;
    }

    const client = this.createPlexDiscoverClient();
    new DiscoverSearchModal(this.app, {
      search: async (query) => client.searchCatalog(query, 20),
      addToWatchlist: async (item: PlexDiscoverSearchItem) => {
        await client.setWatchlisted(item.ratingKey, true);
        const syncResult = await this.executeSync("search-add");
        if (
          syncResult?.skipped &&
          syncResult.report.skipped?.startsWith("lock mantido por")
        ) {
          new Notice("Adicionado no Plex. Sync local sera tentado novamente em 3s.", 5000);
          window.setTimeout(() => {
            void this.executeSync("search-add-retry");
          }, 3000);
        }
      }
    }).open();
  }

  private createPlexTvClient(): PlexTvClient {
    return new PlexTvClient(
      {
        clientIdentifier: this.settings.plexClientIdentifier,
        product: PRODUCT_NAME,
        timeoutSeconds: ensureMinNumber(this.settings.requestTimeoutSeconds, 5)
      },
      this.logger
    );
  }

  private createPlexDiscoverClient(): PlexDiscoverClient {
    return new PlexDiscoverClient(
      {
        accountToken: this.settings.plexAccountToken,
        clientIdentifier: this.settings.plexClientIdentifier,
        product: PRODUCT_NAME,
        timeoutSeconds: ensureMinNumber(this.settings.requestTimeoutSeconds, 5)
      },
      this.logger
    );
  }

  private async waitForPinAuth(
    client: PlexTvClient,
    pin: { id: number; code: string; expiresAt?: number }
  ): Promise<string | null> {
    const maxWaitMs = pin.expiresAt ? Math.max(pin.expiresAt - Date.now(), 10_000) : 5 * 60 * 1000;
    const intervalMs = 2_000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < maxWaitMs) {
      await sleep(intervalMs);
      const token = await client.pollPinToken({
        id: pin.id,
        code: pin.code,
        authUrl: "",
        createdAt: startedAt,
        expiresAt: pin.expiresAt
      });
      if (token) {
        return token;
      }
    }

    return null;
  }

  private setStatus(text: string): void {
    this.statusBar?.setText(text);
  }

  private canRunSync(reason: string): boolean {
    if (this.settings.authMode === "manual") {
      return true;
    }

    if (!this.settings.plexAccountToken.trim()) {
      if (reason === "manual" || reason === "startup") {
        new Notice("Plex Sync: faca login com a conta Plex para iniciar a sincronizacao", 6000);
      }
      this.setStatus("Plex Sync: aguardando login Plex");
      return false;
    }

    if (
      this.settings.authMode === "hybrid_account" &&
      !this.settings.selectedServerMachineId.trim()
    ) {
      if (reason === "manual" || reason === "startup") {
        new Notice(
          "Plex Sync: nenhum servidor selecionado. Use 'Atualizar servidores' e selecione um servidor.",
          7000
        );
      }
      this.setStatus("Plex Sync: aguardando servidor Plex");
      return false;
    }

    return true;
  }
}

function inferAuthMode(raw: Partial<PlexSyncSettings> | null): PlexSyncSettings["authMode"] {
  if (
    raw?.authMode === "manual" ||
    raw?.authMode === "hybrid_account" ||
    raw?.authMode === "account_only"
  ) {
    return raw.authMode;
  }

  const hasManual = Boolean(raw?.plexBaseUrl?.trim() && raw?.plexToken?.trim());
  return hasManual ? "manual" : "hybrid_account";
}

function generateClientIdentifier(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 14);
  return `plex-obsidian-sync-${now}-${rand}`;
}

function getOrCreateLocalDeviceId(): string {
  try {
    const stored = window.localStorage.getItem(LOCAL_DEVICE_ID_KEY);
    if (stored && stored.trim().length > 0) {
      return stored.trim();
    }
    const value = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(LOCAL_DEVICE_ID_KEY, value);
    return value;
  } catch {
    return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(() => resolve(), ms);
  });
}

function extractLocaleFromUser(user: unknown): string | undefined {
  if (!user || typeof user !== "object") {
    return undefined;
  }
  const record = user as Record<string, unknown>;
  const candidates = [record.locale, record.language, record.lang];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function detectObsidianLocale(): string {
  try {
    const appLocale = String((window as unknown as Record<string, unknown>)["appLocale"] || "").trim();
    if (appLocale.length > 0) {
      return appLocale;
    }
  } catch {
    // no-op
  }
  try {
    const appObject = (window as unknown as Record<string, unknown>)["app"] as
      | Record<string, unknown>
      | undefined;
    const localeFromApp = String(appObject?.["locale"] || "").trim();
    if (localeFromApp.length > 0) {
      return localeFromApp;
    }
  } catch {
    // no-op
  }
  try {
    const momentObj = (window as unknown as Record<string, unknown>)["moment"] as
      | { locale?: () => string }
      | undefined;
    const momentLocale = String(momentObj?.locale?.() || "").trim();
    if (momentLocale.length > 0) {
      return momentLocale;
    }
  } catch {
    // no-op
  }
  try {
    const appLocale =
      (window.localStorage.getItem("language") || window.localStorage.getItem("locale") || "").trim();
    if (appLocale.length > 0) {
      return appLocale;
    }
  } catch {
    // no-op
  }
  try {
    const htmlLang = (document.documentElement?.lang || "").trim();
    if (htmlLang.length > 0) {
      return htmlLang;
    }
  } catch {
    // no-op
  }
  try {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale.trim();
    if (intlLocale.length > 0) {
      return intlLocale;
    }
  } catch {
    // no-op
  }
  if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
    const navLocale = navigator.language.trim();
    if (navLocale.length > 0) {
      return navLocale;
    }
  }
  return "en-US";
}
