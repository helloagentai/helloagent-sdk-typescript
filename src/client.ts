import { encode, decode, Role } from "./proto.js";

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

export type IncomingMessage = {
  messageId: string;
  conversationId: string;
  fromHandle: string;
  toHandle: string;
  text: string;
};

export type Handler = (
  msg: IncomingMessage
) => string | Promise<string> | AsyncIterable<string>;

// Minimal logger surface — `console` satisfies it. Plugins can pass their own
// structured logger instead.
export type Logger = {
  info?: (msg: string, ...args: unknown[]) => void;
  warn?: (msg: string, ...args: unknown[]) => void;
  error?: (msg: string, ...args: unknown[]) => void;
};

export type ReconnectOptions = {
  /** Initial backoff in ms. Default 1000. */
  initialMs?: number;
  /** Max backoff in ms. Default 30000. */
  maxMs?: number;
};

export type AgentOptions = {
  /** Long-lived ha_* token, or a plain handle for the legacy skeleton path. */
  token: string;
  /** Optional override; for ha_* tokens the relay resolves the handle. */
  handle?: string;
  /** Defaults to DEFAULT_RELAY. */
  relayUrl?: string;
  reconnect?: ReconnectOptions;
  logger?: Logger;
  /**
   * Fired when the relay returns auth_response.ok=false (token revoked,
   * rotated externally, agent deleted). When set, the run loop stops
   * retrying after this fires — the situation is not transient, the caller
   * needs to re-pair. When unset, retry-forever (legacy) behavior.
   */
  onAuthFailed?: (err: AuthFailedError) => void;
};

/**
 * Thrown by Agent.connectOnce when the relay rejects the auth handshake
 * (auth_response.ok=false). Distinct from generic socket / network errors so
 * the run loop and onAuthFailed listeners can branch on it.
 */
export class AuthFailedError extends Error {
  constructor(public detail: string) {
    super(`auth failed: ${detail}`);
    this.name = "AuthFailedError";
  }
}

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

  protected async connectOnce(): Promise<void> {
    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket error"));
    });
    const authFrame = encode({
      ...envBase(),
      authRequest: { token: this.token, handle: this.handle, role: this.role },
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
 * Long-lived agent connection.
 *
 * Two construction styles are accepted:
 *
 *   new Agent("ha_token")                        // positional, legacy
 *   new Agent("ha_token", "alice/jarvis")        // positional with handle
 *   new Agent({ token, handle, relayUrl, logger, reconnect })
 *
 * The options form is preferred for new code (e.g. the OpenClaw plugin).
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

export class UserClient extends BaseConn {
  constructor(opts: UserClientOptions) {
    const handle = opts.handle ?? "";
    const token = opts.token ?? handle;
    if (!handle && !token) throw new Error("handle or token required");
    super(handle, token, Role.ROLE_USER, opts.relayUrl, opts.logger);
  }

  async connect() {
    await this.connectOnce();
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

export function registerUser(email: string, password: string, handle: string, api: string = DEFAULT_API) {
  return postJson(`${api}/v1/auth/register`, { email, password, handle });
}

export function loginUser(email: string, password: string, api: string = DEFAULT_API) {
  return postJson(`${api}/v1/auth/login`, { email, password });
}

export function registerAgent(handle: string, description = "", api: string = DEFAULT_API, bearer?: string) {
  return postJson(`${api}/v1/agents`, { handle, description }, bearer);
}
