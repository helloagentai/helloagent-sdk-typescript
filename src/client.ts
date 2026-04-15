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

function nowMs(): number {
  return Date.now();
}

function envBase() {
  return { messageId: randomUUID(), tsUnixMs: nowMs() };
}

abstract class BaseConn {
  protected ws?: WebSocket;
  protected readyPromise?: Promise<void>;
  public handle: string;

  constructor(
    handle: string,
    protected token: string,
    protected role: number,
    protected relayUrl: string = DEFAULT_RELAY
  ) {
    this.handle = handle;
  }

  protected async connectOnce(): Promise<void> {
    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket error"));
    });
    // Send auth
    const authFrame = encode({
      ...envBase(),
      authRequest: { token: this.token, handle: this.handle, role: this.role },
    });
    ws.send(authFrame);
    const first = await this.recvRaw();
    if (!first.authResponse || !first.authResponse.ok) {
      throw new Error(`auth failed: ${JSON.stringify(first)}`);
    }
    if (first.authResponse.handle) this.handle = first.authResponse.handle;
  }

  protected send(env: object): void {
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
}

export class Agent extends BaseConn {
  private handler?: Handler;

  constructor(token: string, handle?: string, relayUrl?: string) {
    const h = handle ?? (token.startsWith("ha_") ? "" : token);
    super(h, token, Role.ROLE_AGENT, relayUrl);
  }

  onMessage(fn: Handler) {
    this.handler = fn;
    return fn;
  }

  async run(): Promise<void> {
    let backoff = 1000;
    for (;;) {
      try {
        await this.connectOnce();
        backoff = 1000;
        await this.loop();
      } catch (e) {
        console.warn(`[agent] connection lost: ${e}; reconnecting in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private async loop(): Promise<void> {
    for (;;) {
      const env = await this.recvRaw();
      if (env.sendMessage) {
        void this.handle_(env);
      }
    }
  }

  private async handle_(env: any): Promise<void> {
    const m = env.sendMessage;
    const incoming: IncomingMessage = {
      messageId: env.messageId,
      conversationId: m.conversationId,
      fromHandle: m.fromHandle,
      toHandle: m.toHandle,
      text: m.text ?? "",
    };
    // Ack
    this.send({ ...envBase(), ack: { refMessageId: env.messageId } });
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

  private sendChunk(incoming: IncomingMessage, refId: string, body: string, final: boolean) {
    this.send({
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
  constructor(opts: { handle?: string; token?: string; relayUrl?: string }) {
    const handle = opts.handle ?? "";
    const token = opts.token ?? handle;
    if (!handle && !token) throw new Error("handle or token required");
    super(handle, token, Role.ROLE_USER, opts.relayUrl);
  }

  async connect() {
    await this.connectOnce();
  }

  async sendMessage(toHandle: string, text: string, conversationId?: string): Promise<string> {
    const env = {
      ...envBase(),
      sendMessage: {
        conversationId: conversationId ?? `${this.handle}:${toHandle}`,
        fromHandle: this.handle,
        toHandle,
        text,
      },
    };
    this.send(env);
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
