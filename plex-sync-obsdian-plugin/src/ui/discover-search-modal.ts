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
      row.style.gridTemplateColumns = "72px 1fr auto";
      row.style.alignItems = "start";
      row.style.gap = "10px";
      row.style.padding = "10px 12px";
      row.style.border = "1px solid var(--background-modifier-border)";
      row.style.borderRadius = "8px";
      row.style.background = "var(--background-secondary)";
      row.style.boxShadow = "0 1px 0 rgba(0,0,0,0.12)";
      row.style.marginBottom = "0";

      const posterWrap = row.createDiv();
      posterWrap.style.width = "72px";
      posterWrap.style.height = "108px";
      posterWrap.style.borderRadius = "6px";
      posterWrap.style.overflow = "hidden";
      posterWrap.style.background = "var(--background-modifier-hover)";
      posterWrap.style.display = "flex";
      posterWrap.style.alignItems = "center";
      posterWrap.style.justifyContent = "center";
      posterWrap.style.border = "1px solid var(--background-modifier-border)";
      posterWrap.style.gridRow = "1 / 3";

      if (item.thumb) {
        const img = posterWrap.createEl("img");
        img.src = item.thumb;
        img.alt = `Capa de ${item.title}`;
        img.loading = "lazy";
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "cover";
        img.addEventListener("error", () => {
          img.remove();
          renderPosterFallback(posterWrap, item);
        });
      } else {
        renderPosterFallback(posterWrap, item);
      }

      const headerRow = row.createDiv();
      headerRow.style.gridColumn = "2 / 4";
      headerRow.style.display = "grid";
      headerRow.style.gridTemplateColumns = "1fr auto";
      headerRow.style.alignItems = "center";
      headerRow.style.gap = "10px";

      const headerMeta = headerRow.createDiv();
      headerMeta.style.minWidth = "0";
      headerMeta.style.display = "flex";
      headerMeta.style.flexDirection = "column";
      headerMeta.style.gap = "2px";
      headerMeta.style.overflow = "hidden";

      const titleLine = headerMeta.createDiv();
      titleLine.style.display = "flex";
      titleLine.style.alignItems = "center";
      titleLine.style.gap = "8px";
      titleLine.style.whiteSpace = "nowrap";
      titleLine.style.overflow = "hidden";

      const title = `${item.title}${item.year ? ` (${item.year})` : ""}`;
      const titleEl = titleLine.createEl("strong", { text: title });
      titleEl.style.overflow = "hidden";
      titleEl.style.textOverflow = "ellipsis";

      const badge = titleLine.createSpan({ text: item.type === "show" ? "Série" : "Filme" });
      badge.style.fontSize = "11px";
      badge.style.padding = "2px 6px";
      badge.style.borderRadius = "999px";
      badge.style.background = "var(--background-modifier-hover)";
      badge.style.opacity = "0.9";
      badge.style.flexShrink = "0";

      if (item.originalTitle && item.originalTitle !== item.title) {
        const original = headerMeta.createEl("small", { text: `Título original: ${item.originalTitle}` });
        original.style.fontSize = "12px";
        original.style.opacity = "0.82";
        original.style.overflow = "hidden";
        original.style.textOverflow = "ellipsis";
        original.style.whiteSpace = "nowrap";
      }

      const button = headerRow.createEl("button", { text: "Adicionar" });
      const disabled = this.adding.has(item.ratingKey);
      button.disabled = disabled;
      if (disabled) {
        button.setText("Adicionando...");
      }
      button.style.minWidth = "98px";
      button.style.flexShrink = "0";

      button.addEventListener("click", () => {
        void this.handleAdd(item);
      });

      const synopsis = row.createEl("small", {
        text: buildSynopsisText(item)
      });
      synopsis.style.gridColumn = "2 / 4";
      synopsis.style.display = "-webkit-box";
      synopsis.style.marginTop = "0";
      synopsis.style.opacity = "0.85";
      synopsis.style.lineHeight = "1.35";
      synopsis.style.overflow = "hidden";
      (synopsis.style as CSSStyleDeclaration & { webkitLineClamp?: string }).webkitLineClamp = "3";
      (synopsis.style as CSSStyleDeclaration & { webkitBoxOrient?: string }).webkitBoxOrient =
        "vertical";
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
  const fallback = parent.createDiv({ text: item.type === "show" ? "SER" : "FIL" });
  fallback.style.fontSize = "11px";
  fallback.style.letterSpacing = "0.04em";
  fallback.style.fontWeight = "700";
  fallback.style.opacity = "0.75";
}

function buildSynopsisText(item: PlexDiscoverSearchItem): string {
  const summary = (item.summary || "").replace(/\s+/g, " ").trim();
  if (summary.length > 0) {
    return summary;
  }
  return "Sem sinopse disponível neste resultado.";
}
