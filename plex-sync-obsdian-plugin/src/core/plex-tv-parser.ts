import { XMLParser } from "fast-xml-parser";
import { parseProvides } from "./plex-account-core";
import type { PlexAccountServer, PlexConnection } from "../types";
import { toNumber } from "./utils";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: true,
  trimValues: true
});

export function parsePlexResourcesXml(xml: string): PlexAccountServer[] {
  const root = safeParse(xml);
  const media = getMediaContainer(root);
  const devices = ensureArray(media.Device);

  return devices
    .map((device) => toServer(device))
    .filter((entry): entry is PlexAccountServer => entry !== undefined);
}

function toServer(node: Record<string, unknown>): PlexAccountServer | undefined {
  const machineId = asString(node.clientIdentifier) || asString(node.machineIdentifier);
  const name = asString(node.name);
  if (!machineId || !name) {
    return undefined;
  }

  const connections = ensureArray(node.Connection)
    .map((connection) => toConnection(connection))
    .filter((entry): entry is PlexConnection => entry !== undefined);

  return {
    machineId,
    name,
    accessToken: asString(node.accessToken),
    sourceTitle: asString(node.sourceTitle),
    owned: toBool(node.owned),
    provides: parseProvides(asString(node.provides)),
    connections,
    updatedAt: new Date().toISOString()
  };
}

function toConnection(node: Record<string, unknown>): PlexConnection | undefined {
  const uri = asString(node.uri);
  if (!uri) {
    return undefined;
  }

  return {
    uri,
    local: toBool(node.local),
    protocol: asString(node.protocol),
    address: asString(node.address),
    port: toNumber(node.port),
    relay: toBool(node.relay),
    ipv6: toBool(node.ipv6)
  };
}

function safeParse(xml: string): Record<string, unknown> {
  try {
    return parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Falha ao parsear XML de resources: ${error}`);
  }
}

function getMediaContainer(root: Record<string, unknown>): Record<string, unknown> {
  const media = root.MediaContainer;
  if (!media || typeof media !== "object") {
    return {};
  }
  return media as Record<string, unknown>;
}

function ensureArray(value: unknown): Record<string, unknown>[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "object" && entry !== null) as Record<
      string,
      unknown
    >[];
  }
  if (typeof value === "object") {
    return [value as Record<string, unknown>];
  }
  return [];
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  }
  return false;
}
