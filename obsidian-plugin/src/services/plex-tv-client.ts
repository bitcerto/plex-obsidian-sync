import { requestUrl } from "obsidian";
import { buildPlexAuthUrl, isServerResource } from "../core/plex-account-core";
import { parsePlexResourcesXml } from "../core/plex-tv-parser";
import type { PlexAccountServer, PlexPinSession } from "../types";
import { Logger } from "./logger";

type RequestFn = typeof requestUrl;

interface PlexTvClientOptions {
  clientIdentifier: string;
  product: string;
  timeoutSeconds: number;
}

interface PinCreateResponse {
  id?: number;
  code?: string;
  expiresIn?: number;
}

interface PinPollResponse {
  authToken?: string;
  expiresIn?: number;
}

interface UserResponse {
  id?: number;
  username?: string;
  email?: string;
}

export class PlexTvClient {
  private clientIdentifier: string;
  private product: string;
  private timeoutSeconds: number;
  private logger: Logger;
  private requestFn: RequestFn;

  constructor(
    options: PlexTvClientOptions,
    logger: Logger,
    requestFn: RequestFn = requestUrl
  ) {
    this.clientIdentifier = options.clientIdentifier;
    this.product = options.product;
    this.timeoutSeconds = options.timeoutSeconds;
    this.logger = logger;
    this.requestFn = requestFn;
  }

  async createPinSession(): Promise<PlexPinSession> {
    const url = "https://plex.tv/api/v2/pins?strong=true";
    const headers = this.buildHeaders();
    const response = await this.requestJson<PinCreateResponse>("POST", url, headers);

    if (!response.id || !response.code) {
      throw new Error("Resposta invalida ao criar PIN");
    }

    const expiresInSec = typeof response.expiresIn === "number" ? response.expiresIn : undefined;
    const now = Date.now();
    const session: PlexPinSession = {
      id: response.id,
      code: response.code,
      authUrl: buildPlexAuthUrl(this.clientIdentifier, response.code, this.product),
      createdAt: now,
      expiresAt: expiresInSec ? now + expiresInSec * 1000 : undefined
    };

    return session;
  }

  async pollPinToken(pin: PlexPinSession): Promise<string | null> {
    const params = new URLSearchParams({
      code: pin.code,
      "X-Plex-Client-Identifier": this.clientIdentifier
    });
    const url = `https://plex.tv/api/v2/pins/${pin.id}?${params.toString()}`;
    const response = await this.requestJson<PinPollResponse>("GET", url, this.buildHeaders());

    if (!response.authToken || typeof response.authToken !== "string") {
      return null;
    }
    return response.authToken;
  }

  async validateUser(accountToken: string): Promise<UserResponse> {
    const url = "https://plex.tv/api/v2/user";
    const headers = this.buildHeaders(accountToken);
    const response = await this.requestJson<UserResponse>("GET", url, headers);
    return response;
  }

  async listServers(accountToken: string): Promise<PlexAccountServer[]> {
    const url = "https://plex.tv/api/resources?includeHttps=1";
    const headers = this.buildHeaders(accountToken, { Accept: "application/xml" });
    const response = await this.requestText("GET", url, headers);
    const parsed = parsePlexResourcesXml(response);
    return parsed.filter(isServerResource);
  }

  private buildHeaders(
    token?: string,
    overrides: Record<string, string> = {}
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Plex-Product": this.product,
      "X-Plex-Client-Identifier": this.clientIdentifier,
      "X-Plex-Device-Name": this.product,
      ...overrides
    };
    if (token) {
      headers["X-Plex-Token"] = token;
    }
    return headers;
  }

  private async requestText(
    method: "GET" | "POST",
    url: string,
    headers: Record<string, string>
  ): Promise<string> {
    this.logger.debug(`Plex.tv request ${method} ${url}`);

    const response = await withTimeout(
      this.requestFn({
        url,
        method,
        headers,
        throw: false
      }),
      this.timeoutSeconds * 1000,
      `Timeout Plex.tv ${method} ${url}`
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Erro Plex.tv ${method} ${url}: status=${response.status} body=${truncate(response.text)}`
      );
    }
    return response.text;
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    url: string,
    headers: Record<string, string>
  ): Promise<T> {
    const text = await this.requestText(method, url, headers);
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`Falha ao parsear JSON de ${url}: ${error}`);
    }
  }
}

function truncate(text: string): string {
  if (!text) {
    return "";
  }
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 250 ? `${compact.slice(0, 250)}...` : compact;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timer);
        reject(error);
      });
  });
}
