export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  return (value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

export function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Boolean(value);
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
  return fallback;
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

export function epochSecondsToIso(value: number | undefined): string | undefined {
  if (!value || value <= 0) {
    return undefined;
  }
  return new Date(value * 1000).toISOString();
}

export function normalizeVaultPath(...parts: string[]): string {
  const raw = parts.filter((part) => part.length > 0).join("/");
  return raw
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function ensureMinNumber(value: number, min: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.floor(value));
}

export function isOnline(): boolean {
  const nav = globalThis.navigator;
  if (!nav || typeof nav.onLine !== "boolean") {
    return true;
  }
  return nav.onLine;
}
