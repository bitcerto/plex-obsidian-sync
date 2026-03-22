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
    contentEl.addClass("plex-sync-modal-content");

    const searchRow = contentEl.createDiv({ cls: "plex-sync-search-row" });

    const inputEl = searchRow.createEl("input", { type: "text" });
    inputEl.placeholder = "Digite título (ex.: Matrix)";

    const searchBtn = searchRow.createEl("button", { text: "Buscar" });
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

    this.resultsEl = contentEl.createDiv({ cls: "plex-sync-search-results" });
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

      const posterWrap = row.createDiv({ cls: "plex-sync-poster-wrap" });

      if (item.thumb) {
        const img = posterWrap.createEl("img");
        img.src = item.thumb;
        img.alt = `Capa de ${item.title}`;
        img.loading = "lazy";
        img.addEventListener("error", () => {
          img.remove();
          renderPosterFallback(posterWrap, item);
        });
      } else {
        renderPosterFallback(posterWrap, item);
      }

      const headerRow = row.createDiv({ cls: "plex-sync-item-header" });

      const headerMeta = headerRow.createDiv({ cls: "plex-sync-item-meta" });

      const titleLine = headerMeta.createDiv({ cls: "plex-sync-title-line" });

      const title = `${item.title}${item.year ? ` (${item.year})` : ""}`;
      titleLine.createEl("strong", { text: title });

      titleLine.createSpan({
        cls: "plex-sync-badge",
        text: item.type === "show" ? "Série" : "Filme"
      });

      if (item.originalTitle && item.originalTitle !== item.title) {
        headerMeta.createEl("small", {
          cls: "plex-sync-original-title",
          text: `Título original: ${item.originalTitle}`
        });
      }

      const button = headerRow.createEl("button", {
        cls: "plex-sync-add-button",
        text: "Adicionar"
      });
      const disabled = this.adding.has(item.ratingKey);
      button.disabled = disabled;
      if (disabled) {
        button.setText("Adicionando...");
      }

      button.addEventListener("click", () => {
        void this.handleAdd(item);
      });

      row.createEl("small", {
        cls: "plex-sync-synopsis",
        text: buildSynopsisText(item)
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

function renderPosterFallback(parent: HTMLElement, item: PlexDiscoverSearchItem): void {
  parent.empty();
  parent.createDiv({
    cls: "plex-sync-poster-fallback",
    text: item.type === "show" ? "SER" : "FIL"
  });
}

function buildSynopsisText(item: PlexDiscoverSearchItem): string {
  const summary = (item.summary || "").replace(/\s+/g, " ").trim();
  if (summary.length > 0) {
    return summary;
  }
  return "Sem sinopse disponível neste resultado.";
}
