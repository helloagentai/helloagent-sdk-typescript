import { encode, decode, Role } from "./proto.js";

/**
 * Resolve a WebSocket constructor for the current runtime.
 *
 * - In the browser, use the native `globalThis.WebSocket`.
 * - In Node, prefer the `ws` package: it auto-responds to server-initiated
 *   WebSocket-protocol Ping frames with Pong, which the relay's heartbeat
 *   ([relay/internal/server/server.go:147]) requires (every 25s with a 10s
 *   pong deadline). Node's built-in WHATWG WebSocket (via undici) does not
 *   reliably auto-Pong server pings in current Node releases, which causes
 *   the relay to tear down the connection at the second missed ping (~60s
 *   after connect) and the SDK reconnects in a loop.
 * - If `ws` isn't installed in the Node deps tree, fall back to the global
 *   so the SDK still works (just with the heartbeat caveat above).
 *
 * Resolved once and cached. The lookup is async because in browsers the
 * dynamic `import("ws")` would 404 — we never reach it there because we
 * short-circuit on the global.
 */
let cachedWebSocketCtor: typeof globalThis.WebSocket | null = null;

async function resolveWebSocketCtor(): Promise<typeof globalThis.WebSocket> {
  if (cachedWebSocketCtor) return cachedWebSocketCtor;
  const isNode =
    typeof process !== "undefined" &&
    typeof (process as { versions?: { node?: string } }).versions?.node === "string";
  if (isNode) {
    try {
      const mod = (await import("ws")) as unknown as {
        default?: typeof globalThis.WebSocket;
        WebSocket?: typeof globalThis.WebSocket;
      };
      const ctor = mod.WebSocket ?? mod.default;
      if (ctor) {
        cachedWebSocketCtor = ctor;
        return ctor;
      }
    } catch {
      // `ws` not installed — fall through to globalThis.WebSocket.
    }
  }
  cachedWebSocketCtor = globalThis.WebSocket;
  return cachedWebSocketCtor;
}

// Web Crypto is present in Node 19+ and all modern browsers. No Node polyfill.
const randomUUID: () => string = () => {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback: RFC 4122 v4 from getRandomValues (browsers without secureContext)
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const DEFAULT_RELAY = "ws://localhost:8080/v1/ws";
export const DEFAULT_API = "http://localhost:8080";

/**
 * A single inbound message from a peer, normalized to a stable shape
 * across both Node and browser runtimes.
 *
 * @example
 * ```ts
 * agent.onMessage((msg: IncomingMessage) => {
 *   console.log(`${msg.fromHandle} → ${msg.toHandle}: ${msg.text}`);
 *   return `you said: ${msg.text}`;
 * });
 * ```
 */
export type IncomingMessage = {
  /** Stable per-message identifier — useful for dedup and reply-tracking. */
  messageId: string;
  /** Groups related messages (a "thread" in chat-UI terms). */
  conversationId: string;
  /** Sender handle, e.g. `"alice"` or `"alice/jarvis"`. */
  fromHandle: string;
  /** Receiver handle (this agent or user). */
  toHandle: string;
  /** Message body. */
  text: string;
};

/**
 * Inbound message handler. Return value determines how the reply is framed:
 *
 * - `string` → one final `StreamChunk` (`is_final = true`).
 * - `Promise<string>` → same, awaited.
 * - `AsyncIterable<string>` → each yielded chunk is a separate
 *   `StreamChunk`; the SDK appends a final empty chunk for completion.
 *
 * Returning an empty string is fine — peers see the reply complete (their UI
 * un-pends) and the conversation moves on.
 */
export type Handler = (
  msg: IncomingMessage
) => string | Promise<string> | AsyncIterable<string>;

/**
 * Minimal logger surface. `console` satisfies it. Pass your own structured
 * logger to integrate with plugin/host log systems.
 */
export type Logger = {
  info?: (msg: string, ...args: unknown[]) => void;
  warn?: (msg: string, ...args: unknown[]) => void;
  error?: (msg: string, ...args: unknown[]) => void;
};

/**
 * Tunes the reconnect backoff used by `Agent.run()` / `UserClient.run()`
 * after a transient disconnect. Backoff doubles on each consecutive failure
 * and resets on a successful reconnect.
 */
export type ReconnectOptions = {
  /** Initial backoff in ms. Default 1000. */
  initialMs?: number;
  /** Max backoff in ms. Default 30000. */
  maxMs?: number;
};

/**
 * Constructor options for `Agent`. The only required field is `token`.
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   token: process.env.HA_TOKEN!,
 *   relayUrl: "wss://relay.helloagent.io/v1/ws",
 *   onAuthFailed: (err) => process.exit(1),
 * });
 * ```
 */
export type AgentOptions = {
  /** Long-lived `ha_*` token, or a plain handle for the legacy skeleton path. */
  token: string;
  /** Optional override; for `ha_*` tokens the relay resolves the handle from the token. */
  handle?: string;
  /** Defaults to {@link DEFAULT_RELAY}. */
  relayUrl?: string;
  reconnect?: ReconnectOptions;
  logger?: Logger;
  /**
   * Fired when the relay returns `auth_response.ok = false` (token revoked,
   * rotated externally, agent deleted). When set, the run loop stops
   * retrying after this fires — the situation is not transient, re-pair.
   * When unset, retry-forever (legacy) behavior.
   */
  onAuthFailed?: (err: AuthFailedError) => void;
};

/**
 * Thrown when the relay rejects the auth handshake (`auth_response.ok=false`).
 * Distinct from generic socket / network errors so the run loop and
 * `onAuthFailed` listeners can branch on it.
 *
 * `err.detail` is the JSON-stringified `auth_response` payload.
 *
 * @example
 * ```ts
 * try { await agent.run(); }
 * catch (err) {
 *   if (err instanceof AuthFailedError) {
 *     console.error("re-pair required:", err.detail);
 *   }
 * }
 * ```
 */
export class AuthFailedError extends Error {
  constructor(public detail: string) {
    super(`auth failed: ${detail}`);
    this.name = "AuthFailedError";
  }
}

/**
 * Constructor options for `UserClient` (the `ROLE_USER` counterpart of
 * `Agent`, for browser / mobile / control-UI surfaces).
 */
export type UserClientOptions = {
  handle?: string;
  token?: string;
  relayUrl?: string;
  logger?: Logger;
};

function nowMs(): number {
  return Date.now();
}

function envBase() {
  return { messageId: randomUUID(), tsUnixMs: nowMs() };
}

abstract class BaseConn {
  protected ws?: WebSocket;
  public handle: string;
  protected logger: Logger;

  constructor(
    handle: string,
    protected token: string,
    protected role: number,
    protected relayUrl: string = DEFAULT_RELAY,
    logger?: Logger
  ) {
    this.handle = handle;
    this.logger = logger ?? console;
  }

  protected async connectOnce(authExtras?: {
    sinceWireId?: string;
    deviceId?: string;
  }): Promise<void> {
    const WS = await resolveWebSocketCtor();
    const ws = new WS(this.relayUrl);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket error"));
    });
    const authFrame = encode({
      ...envBase(),
      authRequest: {
        token: this.token,
        handle: this.handle,
        role: this.role,
        // since_wire_id triggers Postgres-backed catch-up replay on
        // the relay before live delivery starts. Empty string = no
        // replay (server treats it as the pre-multi-client default).
        // See docs/multi-client-sessions.md.
        sinceWireId: authExtras?.sinceWireId ?? "",
        deviceId: authExtras?.deviceId ?? "",
      },
    });
    ws.send(authFrame);
    const first = await this.recvRaw();
    if (!first.authResponse || !first.authResponse.ok) {
      throw new AuthFailedError(JSON.stringify(first));
    }
    if (first.authResponse.handle) this.handle = first.authResponse.handle;
  }

  protected sendEnv(env: object): void {
    if (!this.ws) throw new Error("not connected");
    this.ws.send(encode(env));
  }

  protected recvRaw(): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("not connected"));
      const ws = this.ws;
      const onMsg = (ev: MessageEvent) => {
        cleanup();
        const data = new Uint8Array(ev.data as ArrayBuffer);
        resolve(decode(data));
      };
      const onErr = () => {
        cleanup();
        reject(new Error("socket error"));
      };
      const onClose = () => {
        cleanup();
        reject(new Error("socket closed"));
      };
      const cleanup = () => {
        ws.removeEventListener("message", onMsg as any);
        ws.removeEventListener("error", onErr as any);
        ws.removeEventListener("close", onClose as any);
      };
      ws.addEventListener("message", onMsg as any);
      ws.addEventListener("error", onErr as any);
      ws.addEventListener("close", onClose as any);
    });
  }

  protected closeSocket() {
    try {
      this.ws?.close();
    } catch {
      /* swallow */
    }
    this.ws = undefined;
  }
}

/**
 * Long-lived agent connection (`ROLE_AGENT`). Authenticates with an `ha_*`
 * token, listens for inbound peer messages, and optionally sends proactive
 * messages back. The relay binds the handle from the token; you can read it
 * via `agent.handle` after `auth_response` lands.
 *
 * Two construction styles are accepted:
 *
 * ```ts
 * new Agent("ha_token")                          // positional, legacy
 * new Agent("ha_token", "alice/jarvis")          // positional with handle
 * new Agent({ token, handle, relayUrl, logger, reconnect, onAuthFailed })
 * ```
 *
 * The options form is preferred for new code.
 *
 * @example Echo bot
 * ```ts
 * const agent = new Agent({ token: process.env.HA_TOKEN! });
 * agent.onMessage((msg) => `you said: ${msg.text}`);
 * await agent.run();
 * ```
 *
 * @example Streaming reply
 * ```ts
 * agent.onMessage(async function* (msg) {
 *   for (const word of `replying to: ${msg.text}`.split(" ")) {
 *     yield word + " ";
 *     await new Promise((r) => setTimeout(r, 50));
 *   }
 * });
 * ```
 *
 * @example Proactive send
 * ```ts
 * await agent.run();           // assumes top-level await; otherwise: void agent.run();
 * agent.send("alice", "your build finished");
 * ```
 *
 * See {@link AgentOptions}, {@link Handler}, {@link IncomingMessage}, {@link AuthFailedError}.
 */
export class Agent extends BaseConn {
  private handler?: Handler;
  private reconnect: Required<ReconnectOptions>;
  private stopped = false;
  private onAuthFailed?: (err: AuthFailedError) => void;

  constructor(opts: AgentOptions);
  constructor(token: string, handle?: string, relayUrl?: string);
  constructor(
    arg: AgentOptions | string,
    legacyHandle?: string,
    legacyRelayUrl?: string
  ) {
    const opts: AgentOptions =
      typeof arg === "string"
        ? { token: arg, handle: legacyHandle, relayUrl: legacyRelayUrl }
        : arg;
    const handle =
      opts.handle ?? (opts.token.startsWith("ha_") ? "" : opts.token);
    super(handle, opts.token, Role.ROLE_AGENT, opts.relayUrl, opts.logger);
    this.reconnect = {
      initialMs: opts.reconnect?.initialMs ?? 1000,
      maxMs: opts.reconnect?.maxMs ?? 30_000,
    };
    this.onAuthFailed = opts.onAuthFailed;
  }

  onMessage(fn: Handler) {
    this.handler = fn;
    return fn;
  }

  /** Stop the run loop after the next iteration and close the socket. */
  stop(): void {
    this.stopped = true;
    this.closeSocket();
  }

  async run(): Promise<void> {
    let backoff = this.reconnect.initialMs;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        backoff = this.reconnect.initialMs;
        await this.loop();
      } catch (e) {
        if (this.stopped) return;
        // Auth failures are not transient — token revoked, agent deleted, or
        // rotated externally. Surface to the caller and stop retrying when an
        // onAuthFailed listener is registered. Without a listener we fall
        // through to legacy retry-forever behavior so existing callers don't
        // change shape.
        if (e instanceof AuthFailedError && this.onAuthFailed) {
          try {
            this.onAuthFailed(e);
          } catch (cbErr) {
            this.logger.error?.(`[helloagent] onAuthFailed threw: ${cbErr}`);
          }
          this.stop();
          return;
        }
        this.logger.warn?.(
          `[helloagent] connection lost: ${e}; reconnecting in ${backoff}ms`
        );
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, this.reconnect.maxMs);
      }
    }
  }

  /**
   * Send a message proactively (not as a reply). Useful for assistant-initiated
   * outreach. Requires `await agent.run()` to have authenticated the socket
   * already; throws if not connected.
   */
  send(toHandle: string, text: string, conversationId?: string): string {
    const messageId = randomUUID();
    this.sendEnv({
      messageId,
      tsUnixMs: nowMs(),
      sendMessage: {
        conversationId: conversationId ?? `${this.handle}:${toHandle}`,
        fromHandle: this.handle,
        toHandle,
        text,
      },
    });
    return messageId;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const env = await this.recvRaw();
      if (env.sendMessage) {
        void this.dispatch(env);
      }
    }
  }

  private async dispatch(env: any): Promise<void> {
    const m = env.sendMessage;
    const incoming: IncomingMessage = {
      messageId: env.messageId,
      conversationId: m.conversationId,
      fromHandle: m.fromHandle,
      toHandle: m.toHandle,
      text: m.text ?? "",
    };
    this.sendEnv({ ...envBase(), ack: { refMessageId: env.messageId } });
    if (!this.handler) return;
    const result = this.handler(incoming);
    if (typeof result === "string") {
      this.sendChunk(incoming, env.messageId, result, true);
      return;
    }
    if (result && typeof (result as any)[Symbol.asyncIterator] === "function") {
      for await (const chunk of result as AsyncIterable<string>) {
        this.sendChunk(incoming, env.messageId, chunk, false);
      }
      this.sendChunk(incoming, env.messageId, "", true);
      return;
    }
    const text = await (result as Promise<string>);
    this.sendChunk(incoming, env.messageId, text ?? "", true);
  }

  private sendChunk(
    incoming: IncomingMessage,
    refId: string,
    body: string,
    final: boolean
  ) {
    this.sendEnv({
      ...envBase(),
      streamChunk: {
        conversationId: incoming.conversationId,
        fromHandle: this.handle,
        toHandle: incoming.fromHandle,
        refMessageId: refId,
        body,
        isFinal: final,
      },
    });
  }
}

/**
 * `ROLE_USER` counterpart of {@link Agent} — for browser, mobile, and
 * control-UI surfaces that act on behalf of a logged-in user (not an
 * autonomous agent). Same WebSocket transport, same `onMessage` / `send`
 * shape; differs in the wire-level role the relay sees, which affects
 * routing rules (users can target any handle; agents can only respond).
 *
 * Provide either `handle` (for legacy guest sessions) or `token`
 * (a session/SSO token); the constructor throws if neither is given.
 *
 * @example
 * ```ts
 * const client = new UserClient({
 *   handle: "alice",
 *   token: ssoSessionToken,
 *   relayUrl: "wss://relay.helloagent.io/v1/ws",
 * });
 * client.onMessage((msg) => render(msg));
 * await client.run();
 * client.send("alice/jarvis", "what's on my calendar?");
 * ```
 */
export class UserClient extends BaseConn {
  constructor(opts: UserClientOptions) {
    const handle = opts.handle ?? "";
    const token = opts.token ?? handle;
    if (!handle && !token) throw new Error("handle or token required");
    super(handle, token, Role.ROLE_USER, opts.relayUrl, opts.logger);
  }

  /**
   * Open the WebSocket and complete the auth handshake.
   *
   * `opts.sinceWireId` enables multi-client catch-up replay: the relay
   * replays any messages addressed to this user that were created
   * after the supplied wire id, before going live. The caller is
   * responsible for persisting the cursor (e.g., in localStorage) and
   * for advancing it as inbound `SendMessage` envelopes are processed.
   * See docs/multi-client-sessions.md.
   */
  async connect(opts?: { sinceWireId?: string; deviceId?: string }) {
    await this.connectOnce(opts);
  }

  /** Stop and close the socket. */
  stop(): void {
    this.closeSocket();
  }

  async sendMessage(
    toHandle: string,
    text: string,
    conversationId?: string
  ): Promise<string> {
    const env = {
      ...envBase(),
      sendMessage: {
        conversationId: conversationId ?? `${this.handle}:${toHandle}`,
        fromHandle: this.handle,
        toHandle,
        text,
      },
    };
    this.sendEnv(env);
    return env.messageId;
  }

  async recv(): Promise<any> {
    return this.recvRaw();
  }
}

// REST helpers

async function postJson(url: string, body: object, bearer?: string): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return JSON.parse(text);
}

// register / login were removed when HelloAgent moved user identity to
// Supabase Auth. Use supabase-js (`supabase.auth.signUp(...)` /
// `signInWithPassword(...)` / `signInWithOAuth(...)`) to obtain an access
// token, then pass it to `new UserClient({ token, handle })`. First-time
// users must claim a handle via `POST /v1/profile` (see `claimHandle`
// below) before the WebSocket authenticates.
const AUTH_REMOVED_MSG =
  "registerUser/loginUser were removed when HelloAgent moved user identity to Supabase Auth. " +
  "Use supabase-js to obtain an access token, then `new UserClient({ token, handle })`. " +
  "Claim a handle via claimHandle(...) on first sign-in. See docs/web/auth-migration.md.";

export function registerUser(_email?: string, _password?: string, _handle?: string, _api?: string): Promise<never> {
  return Promise.reject(new Error(AUTH_REMOVED_MSG));
}

export function loginUser(_email?: string, _password?: string, _api?: string): Promise<never> {
  return Promise.reject(new Error(AUTH_REMOVED_MSG));
}

/**
 * Claim a handle for a Supabase-authenticated user. Call once after first
 * sign-up / sign-in; subsequent calls return the existing profile.
 */
export function claimHandle(accessToken: string, handle: string, api: string = DEFAULT_API) {
  return postJson(`${api}/v1/profile`, { handle }, accessToken);
}

export function registerAgent(handle: string, description = "", api: string = DEFAULT_API, bearer?: string) {
  return postJson(`${api}/v1/agents`, { handle, description }, bearer);
}
