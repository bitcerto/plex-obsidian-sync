import { Modal } from "obsidian";
import type { SyncReport } from "../types";

export class ReportModal extends Modal {
  private report: SyncReport;

  constructor(app: Modal["app"], report: SyncReport) {
    super(app);
    this.report = report;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Plex Sync - Last Report");

    const pre = contentEl.createEl("pre", { cls: "plex-sync-report-pre" });
    pre.setText(JSON.stringify(this.report, null, 2));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
