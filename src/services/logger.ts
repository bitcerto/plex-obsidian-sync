export class Logger {
  private debugEnabled: boolean;

  constructor(debugEnabled: boolean) {
    this.debugEnabled = debugEnabled;
  }

  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  info(message: string, context?: unknown): void {
    console.debug(`[PlexSync] ${message}`, context ?? "");
  }

  warn(message: string, context?: unknown): void {
    console.warn(`[PlexSync] ${message}`, context ?? "");
  }

  error(message: string, context?: unknown): void {
    console.error(`[PlexSync] ${message}`, context ?? "");
  }

  debug(message: string, context?: unknown): void {
    if (!this.debugEnabled) {
      return;
    }
    console.debug(`[PlexSync] ${message}`, context ?? "");
  }
}
