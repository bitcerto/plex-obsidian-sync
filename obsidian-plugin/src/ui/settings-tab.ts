import { App, PluginSettingTab, Setting } from "obsidian";
import type {
  AuthMode,
  ConflictPolicy,
  ConnectionStrategy,
  PlexSyncSettings
} from "../types";

interface SettingsHost {
  app: App;
  settings: PlexSyncSettings;
  saveSettings: () => Promise<void>;
  loginWithPlexAccount: () => Promise<void>;
  refreshPlexServers: () => Promise<void>;
  logoutPlexAccount: () => Promise<void>;
}

export class PlexSyncSettingTab extends PluginSettingTab {
  private host: SettingsHost;

  constructor(app: App, host: SettingsHost) {
    super(app, host as never);
    this.host = host;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Plex Obsidian Sync" });

    this.renderAuthSettings(containerEl);
    this.renderSyncSettings(containerEl);
    this.renderAdvancedSettings(containerEl);
  }

  private renderAuthSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Autenticacao" });

    new Setting(containerEl)
      .setName("Modo de autenticacao")
      .setDesc("Conta Plex (recomendado) ou PMS manual")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("hybrid_account", "Conta Plex + Descoberta")
          .addOption("account_only", "Conta Plex (sem servidor)")
          .addOption("manual", "Manual (URL + Token do PMS)")
          .setValue(this.host.settings.authMode)
          .onChange(async (value) => {
            this.host.settings.authMode = value as AuthMode;
            await this.host.saveSettings();
            this.display();
          })
      );

    if (this.host.settings.authMode === "hybrid_account") {
      this.renderHybridAccountSettings(containerEl);
      return;
    }

    if (this.host.settings.authMode === "account_only") {
      this.renderAccountOnlySettings(containerEl);
      return;
    }

    this.renderManualSettings(containerEl);
  }

  private renderAccountOnlySettings(containerEl: HTMLElement): void {
    const hasToken = this.host.settings.plexAccountToken.trim().length > 0;
    const loginButtonText = hasToken ? "Relogar com Plex" : "Login com Plex";

    new Setting(containerEl)
      .setName("Status da conta Plex")
      .setDesc(
        hasToken
          ? "Conta conectada (modo sem servidor: watchlist e estado assistido da conta)."
          : "Conta nao conectada. Use o login por PIN."
      );

    new Setting(containerEl)
      .setName("Acoes da conta")
      .setDesc("Login e logout")
      .addButton((button) =>
        button
          .setButtonText(loginButtonText)
          .setCta()
          .onClick(async () => {
            await this.host.loginWithPlexAccount();
            this.display();
          })
      )
      .addButton((button) =>
        button.setButtonText("Logout").onClick(async () => {
          await this.host.logoutPlexAccount();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Modo conta")
      .setDesc(
        "Sincroniza watchlist da conta e estado assistido. Nao exige Plex Media Server local."
      );
  }

  private renderHybridAccountSettings(containerEl: HTMLElement): void {
    const hasToken = this.host.settings.plexAccountToken.trim().length > 0;
    const loginButtonText = hasToken ? "Relogar com Plex" : "Login com Plex";

    new Setting(containerEl)
      .setName("Status da conta Plex")
      .setDesc(
        hasToken
          ? "Conta conectada (token armazenado)."
          : "Conta nao conectada. Use o login por PIN."
      );

    new Setting(containerEl)
      .setName("Acoes da conta")
      .setDesc("Login, refresh de servidores e logout")
      .addButton((button) =>
        button
          .setButtonText(loginButtonText)
          .setCta()
          .onClick(async () => {
            await this.host.loginWithPlexAccount();
            this.display();
          })
      )
      .addButton((button) =>
        button.setButtonText("Atualizar servidores").onClick(async () => {
          await this.host.refreshPlexServers();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("Logout").onClick(async () => {
          await this.host.logoutPlexAccount();
          this.display();
        })
      );

    const serverOptions = this.host.settings.serversCache;
    const hasServers = serverOptions.length > 0;

    new Setting(containerEl)
      .setName("Servidor Plex")
      .setDesc(
        hasServers
          ? "Selecione o servidor vinculado a sua conta"
          : "Nenhum servidor no cache. Use 'Atualizar servidores'."
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("", "Selecione...");
        for (const server of serverOptions) {
          dropdown.addOption(server.machineId, `${server.name} (${server.machineId})`);
        }

        dropdown
          .setValue(this.host.settings.selectedServerMachineId)
          .onChange(async (value) => {
            this.host.settings.selectedServerMachineId = value;
            await this.host.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Estrategia de conexao")
      .setDesc("Prioridade de conexao ao servidor")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("remote_first", "Remoto primeiro")
          .addOption("local_first", "Local primeiro")
          .addOption("local_only", "Somente local")
          .setValue(this.host.settings.connectionStrategy)
          .onChange(async (value) => {
            this.host.settings.connectionStrategy = value as ConnectionStrategy;
            await this.host.saveSettings();
          })
      );
  }

  private renderManualSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Plex Base URL")
      .setDesc("Ex: http://192.168.1.10:32400")
      .addText((text) =>
        text
          .setPlaceholder("http://192.168.1.10:32400")
          .setValue(this.host.settings.plexBaseUrl)
          .onChange(async (value) => {
            this.host.settings.plexBaseUrl = value.trim();
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Plex Token")
      .setDesc("X-Plex-Token")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("token")
          .setValue(this.host.settings.plexToken)
          .onChange(async (value) => {
            this.host.settings.plexToken = value.trim();
            await this.host.saveSettings();
          });
      });
  }

  private renderSyncSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Sincronizacao" });

    new Setting(containerEl)
      .setName("Bibliotecas")
      .setDesc("Separadas por virgula. Vazio = todas movie/show")
      .addTextArea((text) =>
        text
          .setPlaceholder("Filmes,Series")
          .setValue(this.host.settings.libraries.join(","))
          .onChange(async (value) => {
            this.host.settings.libraries = value
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean);
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Pasta das notas")
      .setDesc("Pasta no vault para notas e arquivos tecnicos")
      .addText((text) =>
        text.setValue(this.host.settings.notesFolder).onChange(async (value) => {
          this.host.settings.notesFolder = value.trim() || "Media-Plex";
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Politica de conflito")
      .setDesc("Quando Plex e Obsidian mudam no mesmo ciclo")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("latest", "latest")
          .addOption("plex", "plex")
          .addOption("obsidian", "obsidian")
          .setValue(this.host.settings.conflictPolicy)
          .onChange(async (value) => {
            this.host.settings.conflictPolicy = value as ConflictPolicy;
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Intervalo de sync (segundos)")
      .setDesc("Minimo 30")
      .addText((text) =>
        text
          .setValue(String(this.host.settings.syncIntervalSeconds))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.host.settings.syncIntervalSeconds = Number.isFinite(parsed)
              ? Math.max(30, Math.floor(parsed))
              : 60;
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync no startup")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.syncOnStartup).onChange(async (value) => {
          this.host.settings.syncOnStartup = value;
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Delay startup (segundos)")
      .setDesc("Aguardar antes de iniciar o sync inicial")
      .addText((text) =>
        text
          .setValue(String(this.host.settings.startupDelaySeconds))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.host.settings.startupDelaySeconds = Number.isFinite(parsed)
              ? Math.max(0, Math.floor(parsed))
              : 15;
            await this.host.saveSettings();
          })
      );
  }

  private renderAdvancedSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Avancado" });

    new Setting(containerEl)
      .setName("Sincronizar somente online")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.syncOnlyWhenOnline).onChange(async (value) => {
          this.host.settings.syncOnlyWhenOnline = value;
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Lock TTL (segundos)")
      .setDesc("Controle multi-dispositivo")
      .addText((text) =>
        text
          .setValue(String(this.host.settings.lockTtlSeconds))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.host.settings.lockTtlSeconds = Number.isFinite(parsed)
              ? Math.max(30, Math.floor(parsed))
              : 120;
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Timeout HTTP (segundos)")
      .addText((text) =>
        text
          .setValue(String(this.host.settings.requestTimeoutSeconds))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.host.settings.requestTimeoutSeconds = Number.isFinite(parsed)
              ? Math.max(5, Math.floor(parsed))
              : 20;
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Logs debug")
      .setDesc("Nao inclui token")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.debugLogs).onChange(async (value) => {
          this.host.settings.debugLogs = value;
          await this.host.saveSettings();
        })
      );
  }
}
