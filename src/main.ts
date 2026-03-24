import "./polyfills/buffer";
import { Notice, Plugin } from "obsidian";
import matter from "gray-matter";
import { DEFAULT_SETTINGS, PLUGIN_ID, PROPERTY_KEY_ALIASES_REVERSE } from "./core/constants";
import { ensureMinNumber, normalizeVaultPath } from "./core/utils";
import { PlexDiscoverClient } from "./services/plex-discover-client";
import { Logger } from "./services/logger";
import { SyncEngine } from "./services/sync-engine";
import { PlexTvClient } from "./services/plex-tv-client";
import type { PlexDiscoverSearchItem, PlexSyncSettings, SyncReport } from "./types";
import { DiscoverSearchModal } from "./ui/discover-search-modal";
import { ReportModal } from "./ui/report-modal";
import { PlexSyncSettingTab } from "./ui/settings-tab";

const PRODUCT_NAME = "Plex Sync";
const LOCAL_DEVICE_ID_KEY = "plex-sync.local-device-id";
const LOCAL_ACCOUNT_TOKEN_KEY = "plex-sync.account-token";
const LOCAL_PMS_TOKEN_KEY = "plex-sync.pms-token";
const DELETE_SYNC_DEBOUNCE_MS = 1200;
const MODIFY_SYNC_DEBOUNCE_MS = 450;
const MODIFY_IGNORE_AFTER_SYNC_MS = 900;

export default class PlexObsidianSyncPlugin extends Plugin {
  settings: PlexSyncSettings = { ...DEFAULT_SETTINGS };

  private logger = new Logger(false);
  private engine?: SyncEngine;
  private statusBar?: HTMLElement;
  private deleteSyncTimer: number | null = null;
  private modifySyncTimer: number | null = null;
  private syncingNow = false;
  private ignoreModifySyncUntil = 0;
  private watchedSignatureByPath = new Map<string, string>();
  private pendingPreferredObsidianKeys = new Set<string>();
  private pendingPreferredObsidianWatchedByKey = new Map<string, boolean>();
  private pendingTargetOnlyRatingKeys = new Set<string>();
  private pendingOverrideSeasonRatingKeys = new Set<string>();
  private pendingOverrideEpisodeRatingKeys = new Set<string>();
  private pendingDeletedRatingKeys = new Set<string>();
  private loginInProgress = false;
  private pendingRetrySync: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.settings.obsidianLocale = detectObsidianLocale();

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
    this.registerDeleteSyncHook();
    this.registerCreateSignatureHook();
    this.registerModifySyncHook();
    await this.seedWatchedSignatures();
    this.scheduleSyncJobs();

    this.logger.info(`${PLUGIN_ID} carregado`);
  }

  onunload(): void {
    this.clearScheduledJobs();
    this.setStatus("Plex Sync: unloaded");
  }

  async saveSettings(): Promise<void> {
    // Legacy settings kept only for backwards compatibility with previous plugin versions.
    this.settings.autoSyncEnabled = false;
    this.settings.obsidianLocale = detectObsidianLocale();
    this.settings.syncIntervalSeconds = ensureMinNumber(this.settings.syncIntervalSeconds, 30);
    this.settings.syncOnStartup = false;
    this.settings.startupDelaySeconds = 0;
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
    if (typeof this.settings.plexAccountEmail !== "string") {
      this.settings.plexAccountEmail = "";
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

    this.persistSecretsToLocal();
    await this.saveData(this.buildPersistedSettings());
    this.logger.setDebugEnabled(this.settings.debugLogs);
    this.scheduleSyncJobs();

    if (this.engine) {
      await this.engine.writeServersCache();
    }
  }

  async loginWithPlexAccount(): Promise<void> {
    if (this.loginInProgress) {
      new Notice("Plex Sync: login já em andamento");
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
        new Notice("Plex Sync: não foi possível abrir o navegador automaticamente");
      }

      new Notice("Plex Sync: conclua o login na página Plex aberta. Aguardando autorização...", 8000);
      this.setStatus("Plex Sync: aguardando login Plex...");

      const token = await this.waitForPinAuth(client, pin);
      if (!token) {
        throw new Error("tempo esgotado aguardando autorização do PIN");
      }

      const user = await client.validateUser(token);
      this.settings.plexAccountToken = token;
      this.settings.plexAccountEmail = extractAccountIdentity(user);
      const locale = extractLocaleFromUser(user);
      if (locale) {
        this.settings.plexAccountLocale = locale;
      }
      await this.saveSettings();

      new Notice("Plex Sync: login da conta Plex concluído", 5000);
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
        new Notice("Plex Sync: faça login com a conta Plex antes de atualizar servidores");
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
          "Plex Sync: 0 servidores encontrados nesta conta Plex. Verifique se o PMS está vinculado a esta conta (ou compartilhado para ela), ou use modo manual.",
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
    this.settings.plexAccountEmail = "";
    this.settings.selectedServerMachineId = "";
    this.settings.serversCache = [];
    await this.saveSettings();
    new Notice("Plex Sync: conta Plex desconectada");
  }

  private async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<PlexSyncSettings> | null;
    const localAccountToken = readLocalSecret(LOCAL_ACCOUNT_TOKEN_KEY);
    const localPmsToken = readLocalSecret(LOCAL_PMS_TOKEN_KEY);

    const migratedAuthMode = inferAuthMode(raw, localPmsToken);
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

    this.settings.autoSyncEnabled = false;
    this.settings.syncOnStartup = false;
    this.settings.startupDelaySeconds = 0;
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
    if (typeof this.settings.plexAccountEmail !== "string") {
      this.settings.plexAccountEmail = "";
    }
    this.settings.obsidianLocale = detectObsidianLocale();

    if (this.settings.notesFolder === "Media/Plex") {
      this.settings.notesFolder = "Media-Plex";
    }

    if (!this.settings.plexClientIdentifier) {
      this.settings.plexClientIdentifier = generateClientIdentifier();
    }

    const rawAccountToken = typeof raw?.plexAccountToken === "string" ? raw.plexAccountToken.trim() : "";
    const rawPmsToken = typeof raw?.plexToken === "string" ? raw.plexToken.trim() : "";
    this.settings.plexAccountToken = localAccountToken || rawAccountToken;
    this.settings.plexToken = localPmsToken || rawPmsToken;

    this.persistSecretsToLocal();
    await this.saveData(this.buildPersistedSettings());
  }

  private buildPersistedSettings(): PlexSyncSettings {
    const sanitizedServers = this.settings.serversCache.map((server) => {
      const { accessToken: _omitAccessToken, ...rest } = server;
      return { ...rest };
    });

    return {
      ...this.settings,
      plexAccountToken: "",
      plexToken: "",
      serversCache: sanitizedServers
    };
  }

  private persistSecretsToLocal(): void {
    writeLocalSecret(LOCAL_ACCOUNT_TOKEN_KEY, this.settings.plexAccountToken);
    writeLocalSecret(LOCAL_PMS_TOKEN_KEY, this.settings.plexToken);
  }

  private registerCommands(): void {
    this.addCommand({
      id: "login-with-plex-account",
      name: "Login with Plex account",
      callback: () => {
        void this.loginWithPlexAccount();
      }
    });

    this.addCommand({
      id: "refresh-plex-servers",
      name: "Refresh Plex servers",
      callback: () => {
        void this.refreshPlexServers();
      }
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.executeSync("manual");
      }
    });

    this.addCommand({
      id: "force-full-rebuild",
      name: "Force full rebuild",
      callback: () => {
        void this.executeSync("force-full-rebuild", true);
      }
    });

    this.addCommand({
      id: "reset-local-state",
      name: "Reset local state",
      callback: () => {
        void this.resetLocalState();
      }
    });

    this.addCommand({
      id: "show-last-report",
      name: "Show last sync report",
      callback: () => {
        void this.showLastReport();
      }
    });

    this.addCommand({
      id: "search-add-watchlist",
      name: "Search and add to watchlist",
      callback: () => {
        void this.openDiscoverSearchModal();
      }
    });

    this.addCommand({
      id: "logout-plex-account",
      name: "Logout Plex account",
      callback: () => {
        void this.logoutPlexAccount();
      }
    });
  }

  private scheduleSyncJobs(): void {
    this.clearScheduledJobs();
    this.setStatus("Plex Sync: modo evento (Sync Now + criar/editar/excluir)");
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
    if (this.deleteSyncTimer !== null) {
      window.clearTimeout(this.deleteSyncTimer);
      this.deleteSyncTimer = null;
    }

    if (this.modifySyncTimer !== null) {
      window.clearTimeout(this.modifySyncTimer);
      this.modifySyncTimer = null;
    }
  }

  private async executeSync(
    reason: string,
    forceFullRebuild = false,
    preferredObsidianKeys?: string[],
    preferredObsidianWatchedByKey?: Record<string, boolean>,
    targetRatingKeys?: string[],
    deletedRatingKeys?: string[],
    overrideSeasonRatingKeys?: Set<string>,
    overrideEpisodeRatingKeys?: Set<string>
  ): Promise<{
    report: SyncReport;
    skipped: boolean;
  } | null> {
    if (!this.engine) {
      new Notice("Plex Sync: engine não inicializado");
      return null;
    }

    this.settings.obsidianLocale = detectObsidianLocale();
    if (!this.canRunSync(reason)) {
      return null;
    }

    const isEventSync =
      reason === "note-delete" || reason === "note-modify" || reason === "note-create";

    if (this.syncingNow && (isEventSync || reason === "manual")) {
      this.pendingRetrySync = () => {
        void this.executeSync(
          reason,
          forceFullRebuild,
          preferredObsidianKeys,
          preferredObsidianWatchedByKey,
          targetRatingKeys,
          deletedRatingKeys,
          overrideSeasonRatingKeys,
          overrideEpisodeRatingKeys
        );
      };
      return null;
    }

    this.syncingNow = true;
    try {
      const result = await this.engine.runSync({
        reason,
        forceFullRebuild,
        preferredObsidianKeys,
        preferredObsidianWatchedByKey,
        targetRatingKeys,
        deletedRatingKeys,
        overrideSeasonRatingKeys,
        overrideEpisodeRatingKeys
      });

      this.handleReport(result.report, result.skipped);
      return result;
    } finally {
      this.syncingNow = false;
      this.ignoreModifySyncUntil = Date.now() + MODIFY_IGNORE_AFTER_SYNC_MS;
      this.drainPendingRetrySync();
    }
  }

  private drainPendingRetrySync(): void {
    const pending = this.pendingRetrySync;
    this.pendingRetrySync = null;
    if (pending) {
      window.setTimeout(pending, 500);
    }
  }

  private handleReport(report: SyncReport, skipped: boolean): void {
    if (skipped && report.skipped) {
      if (
        report.reason === "note-delete" ||
        report.reason === "note-modify" ||
        report.reason === "note-create"
      ) {
        this.setStatus(`Plex Sync: ${report.skipped}`);
        return;
      }
      new Notice(`Plex Sync: ${report.skipped}`);
      this.setStatus(`Plex Sync: ${report.skipped}`);
      return;
    }

    const silentSuccess =
      report.reason === "note-delete" ||
      report.reason === "note-modify" ||
      report.reason === "note-create";

    if (report.errors.length > 0) {
      new Notice(
        `Plex Sync com erros: itens=${report.totalItems}, erros=${report.errors.length}`,
        6000
      );
    } else if (!silentSuccess) {
      new Notice(
        `Plex Sync concluído: itens=${report.totalItems}, notas+${report.createdNotes}, atualizações=${report.updatedNotes}`,
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
      new Notice("Plex Sync: nenhum relatório encontrado");
      return;
    }

    new ReportModal(this.app, report).open();
  }

  private openDiscoverSearchModal(): void {
    if (this.settings.authMode !== "account_only") {
      new Notice("Use o modo 'Conta Plex (sem servidor)' para buscar e adicionar via conta.");
      return;
    }

    if (!this.settings.plexAccountToken.trim()) {
      new Notice("Plex Sync: faça login com a conta Plex antes de buscar.");
      return;
    }

    const client = this.createPlexDiscoverClient();
    new DiscoverSearchModal(this.app, {
      search: async (query) => client.searchCatalog(query, 20),
      addToWatchlist: async (item: PlexDiscoverSearchItem) => {
        await client.setWatchlisted(item.ratingKey, true);
        const targetKeys = [item.ratingKey];
        const syncResult = await this.executeSync(
          "search-add",
          false,
          undefined,
          undefined,
          targetKeys
        );
        if (
          syncResult?.skipped &&
          syncResult.report.skipped?.startsWith("lock mantido por")
        ) {
          new Notice("Adicionado no Plex. Sync local será tentado novamente em 3s.", 5000);
          window.setTimeout(() => {
            void this.executeSync(
              "search-add-retry",
              false,
              undefined,
              undefined,
              targetKeys
            );
          }, 3000);
          return;
        }

        if (
          syncResult &&
          !syncResult.skipped &&
          syncResult.report.errors.length === 0 &&
          syncResult.report.totalItems === 0
        ) {
          window.setTimeout(() => {
            void this.executeSync(
              "search-add-reconcile",
              false,
              undefined,
              undefined,
              targetKeys
            );
          }, 1500);
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
        timeoutSeconds: ensureMinNumber(this.settings.requestTimeoutSeconds, 5),
        locale: this.settings.obsidianLocale || this.settings.plexAccountLocale
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

  private registerDeleteSyncHook(): void {
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!this.canScheduleEventSync()) {
          return;
        }

        const filePath = normalizeVaultPath((file as { path?: string }).path || "");
        if (!this.isSyncManagedMarkdown(filePath)) {
          return;
        }

        const previousSignature = this.watchedSignatureByPath.get(filePath);
        const ratingKey = previousSignature ? extractRatingKeyFromSignature(previousSignature) : undefined;
        if (ratingKey) {
          this.pendingDeletedRatingKeys.add(ratingKey);
        }
        this.watchedSignatureByPath.delete(filePath);

        this.scheduleDeleteSync();
      })
    );
  }

  private registerCreateSignatureHook(): void {
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!this.canScheduleEventSync()) {
          return;
        }

        const filePath = normalizeVaultPath((file as { path?: string }).path || "");
        if (!this.isSyncManagedMarkdown(filePath)) {
          return;
        }

        if (this.shouldIgnoreModifySync()) {
          void this.refreshWatchedSignature(filePath);
          return;
        }

        void this.handleNoteCreate(filePath);
      })
    );
  }

  private registerModifySyncHook(): void {
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.canScheduleEventSync()) {
          return;
        }

        const filePath = normalizeVaultPath((file as { path?: string }).path || "");
        if (!this.isSyncManagedMarkdown(filePath)) {
          return;
        }

        if (this.shouldIgnoreModifySync()) {
          void this.refreshWatchedSignature(filePath);
          return;
        }

        void this.handleNoteModify(filePath);
      })
    );
  }

  private canScheduleEventSync(): boolean {
    if (this.settings.authMode === "account_only") {
      return this.settings.plexAccountToken.trim().length > 0;
    }

    if (this.settings.authMode === "hybrid_account") {
      return (
        this.settings.plexAccountToken.trim().length > 0 &&
        this.settings.selectedServerMachineId.trim().length > 0
      );
    }

    return (
      this.settings.plexBaseUrl.trim().length > 0 &&
      this.settings.plexToken.trim().length > 0
    );
  }

  private async handleNoteCreate(filePath: string): Promise<void> {
    if (await this.wasReplicatedManagedCreate(filePath)) {
      await this.refreshWatchedSignature(filePath);
      return;
    }

    const signature = await this.readWatchedSignature(filePath);
    if (!signature) {
      this.watchedSignatureByPath.delete(filePath);
      return;
    }

    this.watchedSignatureByPath.set(filePath, signature);

    const ratingKey = extractRatingKeyFromSignature(signature);
    if (ratingKey) {
      this.pendingPreferredObsidianKeys.add(ratingKey);
      const watched = extractWatchedFromSignature(signature);
      if (typeof watched === "boolean") {
        this.pendingPreferredObsidianWatchedByKey.set(ratingKey, watched);
      }
    }

    this.scheduleModifySync();
  }

  private async wasReplicatedManagedCreate(filePath: string): Promise<boolean> {
    try {
      const raw = await this.app.vault.adapter.read(filePath);
      const parsed = matter(raw);
      if (!isRecord(parsed.data)) {
        return false;
      }

      const normalized = normalizeFrontmatterKeys(parsed.data);
      const syncedAt = asNonEmptyStringValue(normalized.sincronizado_em);
      const syncedBy = asNonEmptyStringValue(normalized.sincronizado_por);
      return Boolean(syncedAt || syncedBy);
    } catch {
      return false;
    }
  }

  private scheduleDeleteSync(): void {
    if (this.deleteSyncTimer !== null) {
      window.clearTimeout(this.deleteSyncTimer);
    }
    this.deleteSyncTimer = window.setTimeout(() => {
      this.deleteSyncTimer = null;
      const deletedKeys = Array.from(this.pendingDeletedRatingKeys);
      this.pendingDeletedRatingKeys.clear();
      void this.executeSync("note-delete", false, undefined, undefined, undefined, deletedKeys);
    }, DELETE_SYNC_DEBOUNCE_MS);
  }

  private scheduleModifySync(): void {
    if (this.modifySyncTimer !== null) {
      window.clearTimeout(this.modifySyncTimer);
    }
    this.modifySyncTimer = window.setTimeout(() => {
      this.modifySyncTimer = null;
      const preferredKeys = Array.from(this.pendingPreferredObsidianKeys);
      const preferredWatchedByKey = Object.fromEntries(
        Array.from(this.pendingPreferredObsidianWatchedByKey.entries())
      );
      const targetOnlyKeys = Array.from(this.pendingTargetOnlyRatingKeys);
      const overrideSeasonKeys = new Set(this.pendingOverrideSeasonRatingKeys);
      const overrideEpisodeKeys = new Set(this.pendingOverrideEpisodeRatingKeys);
      this.pendingPreferredObsidianKeys.clear();
      this.pendingPreferredObsidianWatchedByKey.clear();
      this.pendingTargetOnlyRatingKeys.clear();
      this.pendingOverrideSeasonRatingKeys.clear();
      this.pendingOverrideEpisodeRatingKeys.clear();
      const allTargetKeys = [...preferredKeys, ...targetOnlyKeys];
      void this.executeSync(
        "note-modify",
        false,
        preferredKeys,
        preferredWatchedByKey,
        allTargetKeys,
        undefined,
        overrideSeasonKeys,
        overrideEpisodeKeys
      );
    }, MODIFY_SYNC_DEBOUNCE_MS);
  }

  private async handleNoteModify(filePath: string): Promise<void> {
    const nextSignature = await this.readWatchedSignature(filePath);
    if (!nextSignature) {
      this.watchedSignatureByPath.delete(filePath);
      return;
    }

    const previousSignature = this.watchedSignatureByPath.get(filePath);
    this.watchedSignatureByPath.set(filePath, nextSignature);

    if (previousSignature !== nextSignature) {
      const ratingKey = extractRatingKeyFromSignature(nextSignature);
      const serieRatingKey = extractSerieRatingKeyFromSignature(nextSignature);
      if (serieRatingKey) {
        // Season/episode note: target the parent show for syncShowHierarchy
        // but do NOT mark it as preferred so show-level watched is not forced
        this.pendingTargetOnlyRatingKeys.add(serieRatingKey);
        const noteType = extractTypeFromSignature(nextSignature);
        const seasonCheckboxChanged =
          noteType === "season" &&
          extractSeasonCheckboxSnapshotFromSignature(previousSignature) !==
            extractSeasonCheckboxSnapshotFromSignature(nextSignature);
        if (ratingKey && noteType === "season") {
          // Any season-note modification should re-evaluate that specific season.
          this.pendingOverrideSeasonRatingKeys.add(ratingKey);
        }
        if (ratingKey && noteType === "episode") {
          // Any episode-note modification should re-evaluate that specific episode.
          this.pendingOverrideEpisodeRatingKeys.add(ratingKey);
        }
        if (ratingKey && noteType === "season" && seasonCheckboxChanged) {
          this.pendingOverrideSeasonRatingKeys.add(ratingKey);
        }
      } else if (ratingKey) {
        this.pendingPreferredObsidianKeys.add(ratingKey);
        const watched = extractWatchedFromSignature(nextSignature);
        if (typeof watched === "boolean") {
          this.pendingPreferredObsidianWatchedByKey.set(ratingKey, watched);
        }
      }
      this.scheduleModifySync();
    }
  }

  private async refreshWatchedSignature(filePath: string): Promise<void> {
    const signature = await this.readWatchedSignature(filePath);
    if (!signature) {
      this.watchedSignatureByPath.delete(filePath);
      return;
    }
    this.watchedSignatureByPath.set(filePath, signature);
  }

  private async seedWatchedSignatures(): Promise<void> {
    this.watchedSignatureByPath.clear();
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const filePath = normalizeVaultPath(file.path);
      if (!this.isSyncManagedMarkdown(filePath)) {
        continue;
      }
      await this.refreshWatchedSignature(filePath);
    }
  }

  private shouldIgnoreModifySync(): boolean {
    return this.syncingNow || Date.now() < this.ignoreModifySyncUntil;
  }

  private isSyncManagedMarkdown(filePath: string): boolean {
    if (!filePath.endsWith(".md")) {
      return false;
    }

    const notesRoot = normalizeVaultPath(this.settings.notesFolder);
    const notesPrefix = notesRoot ? `${notesRoot}/` : "";
    if (!filePath.startsWith(notesPrefix)) {
      return false;
    }

    const fileName = filePath.split("/").pop() || "";
    if (fileName.startsWith(".plex-")) {
      return false;
    }

    return true;
  }

  private async readWatchedSignature(filePath: string): Promise<string | undefined> {
    try {
      const raw = await this.app.vault.adapter.read(filePath);
      return buildWatchedSignature(raw);
    } catch {
      return undefined;
    }
  }

  private canRunSync(reason: string): boolean {
    if (this.settings.authMode === "manual") {
      return true;
    }

    if (!this.settings.plexAccountToken.trim()) {
      if (reason === "manual") {
        new Notice("Plex Sync: faça login com a conta Plex para iniciar a sincronização", 6000);
      }
      this.setStatus("Plex Sync: aguardando login Plex");
      return false;
    }

    if (
      this.settings.authMode === "hybrid_account" &&
      !this.settings.selectedServerMachineId.trim()
    ) {
      if (reason === "manual") {
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

function inferAuthMode(
  raw: Partial<PlexSyncSettings> | null,
  localPmsToken?: string
): PlexSyncSettings["authMode"] {
  if (
    raw?.authMode === "manual" ||
    raw?.authMode === "hybrid_account" ||
    raw?.authMode === "account_only"
  ) {
    return raw.authMode;
  }

  const rawToken = raw?.plexToken?.trim();
  const manualToken = localPmsToken?.trim() || rawToken;
  const hasManual = Boolean(raw?.plexBaseUrl?.trim() && manualToken);
  return hasManual ? "manual" : "hybrid_account";
}

function generateClientIdentifier(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 14);
  return `plex-sync-${now}-${rand}`;
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

function readLocalSecret(key: string): string {
  try {
    const value = window.localStorage.getItem(key);
    return value && value.trim().length > 0 ? value.trim() : "";
  } catch {
    return "";
  }
}

function writeLocalSecret(key: string, value: string): void {
  const normalized = value.trim();
  try {
    if (normalized.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, normalized);
  } catch {
    // no-op
  }
}

function buildWatchedSignature(markdown: string): string | undefined {
  const parsed = matter(markdown);
  if (!isRecord(parsed.data)) {
    return undefined;
  }

  const normalized = normalizeFrontmatterKeys(parsed.data);
  const ratingKey = asNonEmptyStringValue(normalized.plex_rating_key);
  const type = asNonEmptyStringValue(normalized.tipo)?.toLowerCase();
  if (!ratingKey || !type) {
    return undefined;
  }

  const supportedType = type === "movie" || type === "show" || type === "season" || type === "episode";
  if (!supportedType) {
    return undefined;
  }

  const watched = parseOptionalBoolValue(normalized.assistido);
  const watchedValue = typeof watched === "boolean" ? (watched ? "1" : "0") : "u";
  const checkboxState = type === "season" ? extractSeasonCheckboxSnapshot(parsed.content) : "";
  const serieRatingKey =
    (type === "season" || type === "episode")
      ? asNonEmptyStringValue(normalized.serie_rating_key) ?? ""
      : "";
  return `${type}|${ratingKey}|${watchedValue}|${checkboxState}|${serieRatingKey}`;
}

function extractTypeFromSignature(signature: string): string | undefined {
  const parts = signature.split("|");
  const type = parts[0]?.trim();
  return type && type.length > 0 ? type : undefined;
}

function extractRatingKeyFromSignature(signature: string): string | undefined {
  const parts = signature.split("|");
  if (parts.length < 2) {
    return undefined;
  }
  const ratingKey = parts[1].trim();
  return ratingKey.length > 0 ? ratingKey : undefined;
}

function extractSerieRatingKeyFromSignature(signature: string): string | undefined {
  const parts = signature.split("|");
  if (parts.length < 5) return undefined;
  const key = parts[4].trim();
  return key.length > 0 ? key : undefined;
}

function extractWatchedFromSignature(signature: string): boolean | undefined {
  const parts = signature.split("|");
  if (parts.length < 3) {
    return undefined;
  }
  const value = parts[2].trim();
  if (value === "1") {
    return true;
  }
  if (value === "0") {
    return false;
  }
  return undefined;
}

function extractSeasonCheckboxSnapshotFromSignature(signature: string): string {
  const parts = signature.split("|");
  if (parts.length < 4) {
    return "";
  }
  return parts[3].trim();
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
  }
  return normalized;
}

function extractSeasonCheckboxSnapshot(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const sectionMatch = normalized.match(
    /<!-- plex-season-episodes:start -->[\s\S]*?<!-- plex-season-episodes:end -->/
  );
  if (!sectionMatch) {
    return "";
  }

  const pairs: string[] = [];
  const lineRegex =
    /^\s*-\s*\[( |x|X)\][^\n]*<!--\s*plex_episode_rating_key:\s*([^\s>]+)\s*-->\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(sectionMatch[0])) !== null) {
    const checked = match[1].toLowerCase() === "x" ? "1" : "0";
    pairs.push(`${match[2]}:${checked}`);
  }

  return pairs.join(",");
}

function parseOptionalBoolValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "sim", "s"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", "nao"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function asNonEmptyStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function extractAccountIdentity(user: unknown): string {
  if (!user || typeof user !== "object") {
    return "";
  }
  const record = user as Record<string, unknown>;
  const candidates = [record.email, record.username];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function detectObsidianLocale(): string {
  try {
    const rawAppLocale = (window as unknown as Record<string, unknown>)["appLocale"];
    const appLocale = typeof rawAppLocale === "string" ? rawAppLocale.trim() : "";
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
    const rawLocale = appObject?.["locale"];
    const localeFromApp = typeof rawLocale === "string" ? rawLocale.trim() : "";
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
