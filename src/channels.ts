import { DEFAULT_API } from "./client.js";

/**
 * Typed error raised by the channel + OAuth helpers. Inspect `code` to branch
 * on the well-known relay error codes (e.g. "handle_taken",
 * "missing_agent_name", "invalid_grant"), and `status` for HTTP-level
 * decisions.
 */
export class HelloAgentApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body?: unknown) {
    super(`${status} ${code}: ${message}`);
    this.name = "HelloAgentApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

type FetchInit = {
  method: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
};

async function request<T>(url: string, init: FetchInit): Promise<T | undefined> {
  const res = await fetch(url, init as RequestInit);
  const text = await res.text();
  if (!res.ok) {
    let code = "http_error";
    let message = text;
    try {
      const parsed = JSON.parse(text);
      code = parsed.code ?? code;
      message = parsed.message ?? message;
      throw new HelloAgentApiError(res.status, code, message, parsed);
    } catch (e) {
      if (e instanceof HelloAgentApiError) throw e;
      throw new HelloAgentApiError(res.status, code, message);
    }
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

// --- Channel link API ---

export type LinkChannelOptions = {
  /** Channel provider id, e.g. "openclaw". */
  provider: string;
  /** Bearer token: a user-session JWT or an OAuth-scoped access token with channel:link. */
  token: string;
  /**
   * User-chosen suffix for the linked agent handle. Required on first link;
   * silently ignored on relink (the bound handle wins).
   */
  agentName?: string;
  /** REST base URL. Defaults to DEFAULT_API. */
  apiUrl?: string;
};

export type LinkChannelResponse = {
  provider: string;
  handle: string;
  agent_name: string;
  display_name: string;
  user_handle: string;
  /** Long-lived ha_* token. Shown once; persist server-side. */
  token: string;
  relay_ws: string;
};

export async function linkChannel(opts: LinkChannelOptions): Promise<LinkChannelResponse> {
  const api = opts.apiUrl ?? DEFAULT_API;
  const body: Record<string, string> = {};
  if (opts.agentName !== undefined) body.agent_name = opts.agentName;
  return (await request<LinkChannelResponse>(
    `${api}/v1/channels/${encodeURIComponent(opts.provider)}/link`,
    {
      method: "POST",
      headers: jsonHeaders(opts.token),
      body: JSON.stringify(body),
    }
  )) as LinkChannelResponse;
}

export type ChannelListEntry = {
  provider: string;
  handle: string;
  agent_name: string;
  display_name: string;
};

export async function listChannels(
  token: string,
  apiUrl: string = DEFAULT_API
): Promise<ChannelListEntry[]> {
  return (
    (await request<ChannelListEntry[]>(`${apiUrl}/v1/channels`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })) ?? []
  );
}

export async function unlinkChannel(
  provider: string,
  token: string,
  apiUrl: string = DEFAULT_API
): Promise<void> {
  await request<void>(`${apiUrl}/v1/channels/${encodeURIComponent(provider)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// --- OAuth 2.0 helpers ---

export type OAuthAuthorizeOptions = {
  /** User-session JWT — the Bearer authenticating the resource owner. */
  userToken: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state?: string;
  apiUrl?: string;
};

export type OAuthAuthorizeResponse = {
  code: string;
  state?: string;
  redirect_url: string;
};

/**
 * Server-side mint of an authorization code. Intended for the HelloAgent web
 * UI's consent screen, not for plugins. Plugins normally receive the code via
 * the browser redirect to their loopback URI and skip this call.
 */
export async function oauthAuthorize(
  opts: OAuthAuthorizeOptions
): Promise<OAuthAuthorizeResponse> {
  const api = opts.apiUrl ?? DEFAULT_API;
  return (await request<OAuthAuthorizeResponse>(`${api}/oauth/authorize`, {
    method: "POST",
    headers: jsonHeaders(opts.userToken),
    body: JSON.stringify({
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      scope: opts.scope ?? "channel:link",
      state: opts.state ?? "",
    }),
  })) as OAuthAuthorizeResponse;
}

export type OAuthTokenOptions = {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  apiUrl?: string;
};

export type OAuthTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
};

/** Exchange an authorization code for a scoped access token. */
export async function oauthExchangeToken(
  opts: OAuthTokenOptions
): Promise<OAuthTokenResponse> {
  const api = opts.apiUrl ?? DEFAULT_API;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
  });
  return (await request<OAuthTokenResponse>(`${api}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  })) as OAuthTokenResponse;
}
