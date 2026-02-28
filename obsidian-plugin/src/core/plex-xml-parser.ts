import { XMLParser } from "fast-xml-parser";
import type { PlexMediaItem, PlexSection } from "../types";
import { toNumber } from "./utils";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: true,
  trimValues: true
});

export function parseSectionsXml(xml: string): PlexSection[] {
  const root = safeParse(xml);
  const media = getMediaContainer(root);
  const directories = ensureArray(media.Directory);

  return directories
    .map((node) => ({
      key: asString(node.key),
      title: asString(node.title),
      type: asString(node.type)
    }))
    .filter((entry): entry is PlexSection => Boolean(entry.key && entry.title && entry.type));
}

export function parseItemsXml(xml: string, libraryTitle: string): PlexMediaItem[] {
  const root = safeParse(xml);
  const media = getMediaContainer(root);
  const videos = ensureArray(media.Video);
  const directories = ensureArray(media.Directory);
  const nodes = [...videos, ...directories];

  const items = nodes
    .map((node) => toMediaItem(node, libraryTitle))
    .filter((item): item is PlexMediaItem => item !== undefined)
    .filter((item) => item.type === "movie" || item.type === "show");

  const dedup = new Map<string, PlexMediaItem>();
  for (const item of items) {
    dedup.set(item.ratingKey, item);
  }

  return Array.from(dedup.values());
}

function safeParse(xml: string): Record<string, unknown> {
  try {
    return parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Falha ao parsear XML do Plex: ${error}`);
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

function toMediaItem(
  node: Record<string, unknown>,
  libraryTitle: string
): PlexMediaItem | undefined {
  const ratingKey = asString(node.ratingKey);
  const title = asString(node.title);
  const type = asString(node.type);

  if (!ratingKey || !title || !type) {
    return undefined;
  }

  return {
    ratingKey,
    guid: asString(node.guid),
    type,
    title,
    originalTitle: asString(node.originalTitle),
    year: toNumber(node.year),
    summary: asString(node.summary),
    rating: toNumber(node.rating),
    ratingImage: asString(node.ratingImage),
    audienceRating: toNumber(node.audienceRating),
    audienceRatingImage: asString(node.audienceRatingImage),
    thumb: asString(node.thumb),
    art: asString(node.art),
    durationMs: toNumber(node.duration),
    viewCount: toNumber(node.viewCount),
    viewedLeafCount: toNumber(node.viewedLeafCount),
    leafCount: toNumber(node.leafCount),
    childCount: toNumber(node.childCount),
    lastViewedAt: toNumber(node.lastViewedAt),
    updatedAt: toNumber(node.updatedAt),
    libraryTitle
  };
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
