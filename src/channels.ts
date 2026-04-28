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
   * User-chosen suffix for the linked agent handle. Required for each link.
   * Reusing a suffix conflicts with the existing handle; choose another name
   * to create another provider-backed agent.
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
  /** Long-lived ha_* token. Shown once; persist locally on the provider. */
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
  /** PKCE S256 code challenge for public/local clients. */
  codeChallenge?: string;
  codeChallengeMethod?: "S256";
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
      ...(opts.codeChallenge
        ? {
            code_challenge: opts.codeChallenge,
            code_challenge_method: opts.codeChallengeMethod ?? "S256",
          }
        : {}),
    }),
  })) as OAuthAuthorizeResponse;
}

export type OAuthTokenOptions = {
  clientId: string;
  /** Confidential clients may pass a secret; public clients should use PKCE. */
  clientSecret?: string;
  code: string;
  redirectUri: string;
  /** PKCE verifier matching the authorization request's code challenge. */
  codeVerifier?: string;
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
    redirect_uri: opts.redirectUri,
  });
  if (opts.clientSecret !== undefined) form.set("client_secret", opts.clientSecret);
  if (opts.codeVerifier !== undefined) form.set("code_verifier", opts.codeVerifier);
  return (await request<OAuthTokenResponse>(`${api}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  })) as OAuthTokenResponse;
}

export type OAuthDeviceAuthorizeOptions = {
  clientId: string;
  scope?: string;
  apiUrl?: string;
};

export type OAuthDeviceAuthorizeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export async function oauthStartDeviceAuthorization(
  opts: OAuthDeviceAuthorizeOptions
): Promise<OAuthDeviceAuthorizeResponse> {
  const api = opts.apiUrl ?? DEFAULT_API;
  return (await request<OAuthDeviceAuthorizeResponse>(
    `${api}/oauth/device/authorize`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: opts.clientId,
        scope: opts.scope ?? "channel:link",
      }),
    }
  )) as OAuthDeviceAuthorizeResponse;
}

export type OAuthDeviceApproveOptions = {
  userToken: string;
  clientId: string;
  userCode: string;
  apiUrl?: string;
};

export type OAuthDeviceApproveResponse = {
  client_id: string;
  scope: string;
  approved: boolean;
};

export async function oauthApproveDeviceAuthorization(
  opts: OAuthDeviceApproveOptions
): Promise<OAuthDeviceApproveResponse> {
  const api = opts.apiUrl ?? DEFAULT_API;
  return (await request<OAuthDeviceApproveResponse>(
    `${api}/oauth/device/approve`,
    {
      method: "POST",
      headers: jsonHeaders(opts.userToken),
      body: JSON.stringify({
        client_id: opts.clientId,
        user_code: opts.userCode,
      }),
    }
  )) as OAuthDeviceApproveResponse;
}

export type OAuthDeviceTokenOptions = {
  clientId: string;
  deviceCode: string;
  apiUrl?: string;
};

export async function oauthPollDeviceToken(
  opts: OAuthDeviceTokenOptions
): Promise<OAuthTokenResponse> {
  const api = opts.apiUrl ?? DEFAULT_API;
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: opts.clientId,
    device_code: opts.deviceCode,
  });
  return (await request<OAuthTokenResponse>(`${api}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  })) as OAuthTokenResponse;
}
