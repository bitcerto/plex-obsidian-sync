import {
  orderConnections,
  tokenCandidates
} from "../core/plex-account-core";
import { ensureMinNumber } from "../core/utils";
import type { PlexMediaItem, PlexSection, PlexSyncSettings } from "../types";
import { Logger } from "./logger";
import { PmsClient } from "./plex-client";

export interface ResolvedPmsTarget {
  baseUrl: string;
  token: string;
  serverName?: string;
  machineId?: string;
  connectionUri?: string;
}

export async function fetchPlexItems(params: {
  client: PmsClient;
  settings: PlexSyncSettings;
  logger: Logger;
}): Promise<PlexMediaItem[]> {
  const { client, settings, logger } = params;
  const sections = await client.listSections();
  if (sections.length === 0) {
    throw new Error(
      "Plex retornou zero bibliotecas. Crie pelo menos uma biblioteca de Filmes ou Programas de TV no servidor."
    );
  }

  const targetSections = pickTargetSections(sections, settings, logger);
  if (targetSections.length === 0) {
    const available = sections
      .filter((section) => section.type === "movie" || section.type === "show")
      .map((section) => `${section.title} (${section.type})`);

    if (available.length === 0) {
      throw new Error(
        "Nenhuma biblioteca do tipo movie/show foi encontrada no Plex. O plugin sincroniza apenas Filmes e Programas de TV."
      );
    }

    throw new Error(
      `Nenhuma biblioteca selecionada corresponde ao servidor. Disponiveis: ${available.join(", ")}`
    );
  }

  const allItems: PlexMediaItem[] = [];
  for (const section of targetSections) {
    const items = await client.listLibraryItems(section.key, section.title);
    allItems.push(...items);
  }

  const dedup = new Map<string, PlexMediaItem>();
  for (const item of allItems) {
    dedup.set(item.ratingKey, item);
  }

  return Array.from(dedup.values());
}

export async function resolvePmsTarget(params: {
  settings: PlexSyncSettings;
  logger: Logger;
}): Promise<ResolvedPmsTarget> {
  const { settings, logger } = params;
  const timeoutSeconds = ensureMinNumber(settings.requestTimeoutSeconds, 5);

  if (settings.authMode === "manual") {
    if (!settings.plexBaseUrl.trim() || !settings.plexToken.trim()) {
      throw new Error("configure plexBaseUrl e plexToken nas settings (modo manual)");
    }
    return {
      baseUrl: settings.plexBaseUrl.trim(),
      token: settings.plexToken.trim(),
      serverName: "manual",
      connectionUri: settings.plexBaseUrl.trim()
    };
  }

  if (!settings.plexAccountToken.trim()) {
    throw new Error("modo conta Plex: faça login primeiro (Plex Sync: Login with Plex Account)");
  }

  if (!settings.selectedServerMachineId.trim()) {
    throw new Error("modo conta Plex: selecione um servidor em Settings");
  }

  const server = settings.serversCache.find(
    (entry) => entry.machineId === settings.selectedServerMachineId
  );

  if (!server) {
    throw new Error("servidor selecionado não encontrado no cache. Rode 'Refresh Plex Servers'");
  }

  const orderedConnections = orderConnections(server.connections, settings.connectionStrategy);
  if (orderedConnections.length === 0) {
    throw new Error("servidor sem conexoes disponiveis para a estrategia selecionada");
  }

  const tokens = tokenCandidates(server.accessToken, settings.plexAccountToken);
  if (tokens.length === 0) {
    throw new Error("token ausente para acessar o servidor selecionado");
  }

  const probeErrors: string[] = [];

  for (const connection of orderedConnections) {
    for (const token of tokens) {
      try {
        const probeClient = new PmsClient(
          {
            baseUrl: connection.uri,
            token,
            timeoutSeconds
          },
          logger
        );
        await probeClient.listSections();
        return {
          baseUrl: connection.uri,
          token,
          serverName: server.name,
          machineId: server.machineId,
          connectionUri: connection.uri
        };
      } catch (error) {
        probeErrors.push(`${connection.uri} => ${String(error)}`);
        logger.debug("falha probe PMS", {
          connection: connection.uri,
          error: String(error)
        });
      }
    }
  }

  throw new Error(
    `falha ao conectar no servidor '${server.name}' (${server.machineId}). tentativas: ${probeErrors.length}`
  );
}

function pickTargetSections(
  sections: PlexSection[],
  settings: PlexSyncSettings,
  logger: Logger
): PlexSection[] {
  const requested = settings.libraries.map((entry) => entry.trim()).filter(Boolean);

  if (requested.length === 0) {
    return sections.filter((section) => section.type === "movie" || section.type === "show");
  }

  const byTitle = new Map<string, PlexSection>(
    sections.map((section) => [section.title.toLowerCase(), section])
  );

  const selected: PlexSection[] = [];
  for (const name of requested) {
    const section = byTitle.get(name.toLowerCase());
    if (!section) {
      logger.warn(`Biblioteca '${name}' não encontrada no Plex`);
      continue;
    }
    if (!(section.type === "movie" || section.type === "show")) {
      logger.warn(`Biblioteca '${name}' tipo '${section.type}' não suportada`);
      continue;
    }
    selected.push(section);
  }

  return selected;
}
