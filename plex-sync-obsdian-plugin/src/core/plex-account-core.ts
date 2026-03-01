import type {
  ConnectionStrategy,
  PlexAccountServer,
  PlexConnection
} from "../types";

export function buildPlexAuthUrl(clientIdentifier: string, pinCode: string, product: string): string {
  const params = new URLSearchParams({
    clientID: clientIdentifier,
    code: pinCode,
    "context[device][product]": product
  });
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

export function parseProvides(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isServerResource(server: PlexAccountServer): boolean {
  return server.provides.includes("server");
}

export function orderConnections(
  connections: PlexConnection[],
  strategy: ConnectionStrategy
): PlexConnection[] {
  const onlyLocal = strategy === "local_only";
  if (onlyLocal) {
    return connections.filter((conn) => conn.local);
  }

  const local = connections.filter((conn) => conn.local);
  const remote = connections.filter((conn) => !conn.local);
  return strategy === "remote_first" ? [...remote, ...local] : [...local, ...remote];
}

export function tokenCandidates(serverToken?: string, accountToken?: string): string[] {
  const candidates: string[] = [];
  if (serverToken && serverToken.trim()) {
    candidates.push(serverToken.trim());
  }
  if (accountToken && accountToken.trim() && accountToken.trim() !== serverToken?.trim()) {
    candidates.push(accountToken.trim());
  }
  return candidates;
}
