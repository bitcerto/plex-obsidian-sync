import { Modal, Notice } from "obsidian";
import type { PlexDiscoverSearchItem } from "../types";

interface DiscoverSearchModalOptions {
  search: (query: string) => Promise<PlexDiscoverSearchItem[]>;
  addToWatchlist: (item: PlexDiscoverSearchItem) => Promise<void>;
}

export class DiscoverSearchModal extends Modal {
  private options: DiscoverSearchModalOptions;
  private query = "";
  private searching = false;
  private adding = new Set<string>();
  private results: PlexDiscoverSearchItem[] = [];
  private resultsEl!: HTMLElement;

  constructor(app: Modal["app"], options: DiscoverSearchModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Buscar filme/série no Plex");
    contentEl.style.display = "flex";
    contentEl.style.flexDirection = "column";
    contentEl.style.gap = "12px";
    contentEl.style.paddingBottom = "4px";

    const searchRow = contentEl.createDiv({ cls: "plex-sync-search-row" });
    searchRow.style.display = "flex";
    searchRow.style.alignItems = "center";
    searchRow.style.gap = "8px";

    const inputEl = searchRow.createEl("input", { type: "text" });
    inputEl.placeholder = "Digite título (ex.: Matrix)";
    inputEl.style.flex = "1";

    const searchBtn = searchRow.createEl("button", { text: "Buscar" });
    searchBtn.style.minWidth = "92px";
    const runSearch = async (): Promise<void> => {
      const value = inputEl.value.trim();
      this.query = value;
      if (value.length < 2) {
        new Notice("Digite pelo menos 2 caracteres para buscar.");
        return;
      }
      await this.search();
    };

    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void runSearch();
      }
    });
    searchBtn.addEventListener("click", () => {
      void runSearch();
    });

    const helper = contentEl.createDiv({ cls: "plex-sync-search-help" });
    helper.setText("Busca na conta Plex Discover. Clique em 'Adicionar' para enviar à Lista para assistir.");
    helper.style.fontSize = "12px";
    helper.style.opacity = "0.85";
    helper.style.lineHeight = "1.35";

    this.resultsEl = contentEl.createDiv({ cls: "plex-sync-search-results" });
    this.resultsEl.style.maxHeight = "55vh";
    this.resultsEl.style.overflowY = "auto";
    this.resultsEl.style.paddingRight = "4px";
    this.resultsEl.style.display = "flex";
    this.resultsEl.style.flexDirection = "column";
    this.resultsEl.style.gap = "10px";
    this.renderResults();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async search(): Promise<void> {
    if (this.searching) {
      return;
    }
    this.searching = true;
    this.resultsEl.empty();
    this.resultsEl.createEl("p", { text: "Buscando..." });

    try {
      this.results = await this.options.search(this.query);
      this.renderResults();
    } catch (error) {
      this.resultsEl.empty();
      this.resultsEl.createEl("p", { text: `Erro na busca: ${String(error)}` });
    } finally {
      this.searching = false;
    }
  }

  private renderResults(): void {
    if (!this.resultsEl) {
      return;
    }

    this.resultsEl.empty();
    if (this.results.length === 0) {
      this.resultsEl.createEl("p", { text: "Sem resultados." });
      return;
    }

    for (const item of this.results) {
      const row = this.resultsEl.createDiv({ cls: "plex-sync-search-item" });
      row.style.display = "grid";
      row.style.gridTemplateColumns = "1fr auto";
      row.style.alignItems = "start";
      row.style.gap = "10px";
      row.style.padding = "10px 12px";
      row.style.border = "1px solid var(--background-modifier-border)";
      row.style.borderRadius = "8px";
      row.style.background = "var(--background-secondary)";
      row.style.boxShadow = "0 1px 0 rgba(0,0,0,0.12)";
      row.style.marginBottom = "0";

      const meta = row.createDiv();
      meta.style.minWidth = "0";

      const titleRow = meta.createDiv();
      titleRow.style.display = "flex";
      titleRow.style.alignItems = "center";
      titleRow.style.gap = "8px";
      titleRow.style.flexWrap = "wrap";

      const title = `${item.title}${item.year ? ` (${item.year})` : ""}`;
      titleRow.createEl("strong", { text: title });

      const badge = titleRow.createSpan({ text: item.type === "show" ? "Série" : "Filme" });
      badge.style.fontSize = "11px";
      badge.style.padding = "2px 6px";
      badge.style.borderRadius = "999px";
      badge.style.background = "var(--background-modifier-hover)";
      badge.style.opacity = "0.9";

      if (item.originalTitle && item.originalTitle !== item.title) {
        const original = meta.createEl("div", { text: `Título original: ${item.originalTitle}` });
        original.style.fontSize = "12px";
        original.style.opacity = "0.85";
        original.style.marginTop = "3px";
      }

      const subtitle = meta.createEl("small", { text: `ratingKey: ${item.ratingKey}` });
      subtitle.style.display = "block";
      subtitle.style.marginTop = "4px";
      subtitle.style.opacity = "0.8";
      subtitle.style.fontFamily = "var(--font-monospace)";

      const button = row.createEl("button", { text: "Adicionar" });
      const disabled = this.adding.has(item.ratingKey);
      button.disabled = disabled;
      if (disabled) {
        button.setText("Adicionando...");
      }
      button.style.minWidth = "98px";

      button.addEventListener("click", () => {
        void this.handleAdd(item);
      });
    }
  }

  private async handleAdd(item: PlexDiscoverSearchItem): Promise<void> {
    if (this.adding.has(item.ratingKey)) {
      return;
    }

    this.adding.add(item.ratingKey);
    this.renderResults();

    try {
      await this.options.addToWatchlist(item);
      new Notice(`Adicionado: ${item.title}`);
    } catch (error) {
      new Notice(`Falha ao adicionar ${item.title}: ${String(error)}`, 7000);
    } finally {
      this.adding.delete(item.ratingKey);
      this.renderResults();
    }
  }
}
