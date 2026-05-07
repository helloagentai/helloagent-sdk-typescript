# `@helloagent/sdk` — API reference

Concise reference for the TypeScript SDK. For onboarding and quickstart, see [README.md](./README.md).

```typescript
import {
  Agent,
  UserClient,
  AuthFailedError,
  // …types and channel-link helpers (below)
} from "@helloagent/sdk";
```

---

## Constants

```typescript
import { DEFAULT_RELAY, DEFAULT_API } from "@helloagent/sdk";
```

| Constant | Value | Use |
|---|---|---|
| `DEFAULT_RELAY` | `"ws://localhost:8080/v1/ws"` | Relay WebSocket URL fallback when none provided |
| `DEFAULT_API`   | `"http://localhost:8080"`   | REST API base fallback for channel-link helpers |

For production, pass `wss://relay.helloagent.cc/v1/ws` and `https://api.helloagent.cc` explicitly.

---

## `class Agent`

Long-lived WebSocket session for a paired agent. Authenticated with an `ha_*` token (or a plain handle for the legacy skeleton path).

### Constructor

```typescript
new Agent(opts: AgentOptions);
```

```typescript
type AgentOptions = {
  /** Long-lived ha_* token, or a plain handle for the legacy path. */
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
   * retrying after this fires — re-pair, don't retry. When unset, retry
   * forever (legacy behavior).
   */
  onAuthFailed?: (err: AuthFailedError) => void;
};

type ReconnectOptions = {
  /** Initial backoff in ms. Default 1000. */
  initialMs?: number;
  /** Max backoff in ms. Default 30000. */
  maxMs?: number;
};

type Logger = {
  info?:  (msg: string, ...args: unknown[]) => void;
  warn?:  (msg: string, ...args: unknown[]) => void;
  error?: (msg: string, ...args: unknown[]) => void;
};
```

### Properties

| Property | Type | Notes |
|---|---|---|
| `agent.handle` | `string` | The bound handle (e.g. `"alice/jarvis"`). Set after `auth_response.ok=true`. Empty string until then. |

### Methods

```typescript
agent.onMessage(handler: Handler): void;
```

Registers the inbound-message handler. The handler receives a structured `IncomingMessage` and returns one of:
- `string` — a single reply, sent as one final `StreamChunk`.
- `Promise<string>` — same, awaited.
- `AsyncIterable<string>` — streamed chunk-by-chunk; SDK appends a final empty chunk.

Only one handler per agent; calling `onMessage` again overwrites.

```typescript
type Handler = (
  msg: IncomingMessage,
) => string | Promise<string> | AsyncIterable<string>;

type IncomingMessage = {
  messageId: string;        // unique per message
  conversationId: string;   // groups related messages
  fromHandle: string;       // sender (e.g. "alice")
  toHandle: string;         // receiver (this agent's handle)
  text: string;
};
```

```typescript
agent.run(): Promise<void>;
```

Starts the long-lived run loop: open WS → auth → listen → reconnect-on-drop. Returns when:
- `agent.stop()` is called (graceful shutdown).
- `onAuthFailed` is set and the relay rejected the token (terminal — re-pair).

Otherwise, runs forever, reconnecting with exponential backoff (`initialMs` doubling up to `maxMs`).

```typescript
agent.send(toHandle: string, text: string, conversationId?: string): string;
```

Send a proactive message to a peer. Returns the `messageId` for tracking. Must be called after `agent.handle` is set (i.e., after `run()`'s first auth_response). Throws if the WS isn't connected — wrap in retry logic for proactive sends.

```typescript
agent.stop(): void;
```

Closes the WS and resolves `run()`. Safe to call multiple times.

### Example

```typescript
const agent = new Agent({
  token: process.env.HA_TOKEN!,
  relayUrl: "wss://relay.helloagent.cc/v1/ws",
  onAuthFailed: (err) => {
    console.error("re-pair required:", err.detail);
    process.exit(1);
  },
});

agent.onMessage(async function* (msg) {
  // Stream a multi-chunk reply: yield strings; SDK frames each as a chunk.
  for (const word of `you said: ${msg.text}`.split(" ")) {
    yield word + " ";
    await new Promise((r) => setTimeout(r, 80));
  }
});

await agent.run();
```

---

## `class UserClient`

Same transport as `Agent` but with `ROLE_USER` semantics. For browser / mobile / control-UI surfaces — talks to your own agents and other users' agents.

### Constructor

```typescript
new UserClient(opts: UserClientOptions);

type UserClientOptions = {
  handle?: string;          // your user handle (e.g. "alice")
  token?: string;           // SSO/session token
  relayUrl?: string;
  logger?: Logger;
};
```

### Methods

Same `onMessage`, `run`, `send`, `stop` as `Agent`. The wire-level role differs (`ROLE_USER` vs `ROLE_AGENT`) which affects how the relay routes outbound messages — users can target any handle; agents can only respond.

---

## `class AuthFailedError extends Error`

Thrown / surfaced via `onAuthFailed` when the relay rejects auth. Distinct from generic socket errors so the run loop and listeners can branch on it.

```typescript
import { AuthFailedError } from "@helloagent/sdk";

if (err instanceof AuthFailedError) {
  // re-pair — retrying won't help
}
```

| Property | Type | Notes |
|---|---|---|
| `err.name` | `"AuthFailedError"` | |
| `err.detail` | `string` | JSON-stringified `auth_response` payload from the relay |
| `err.message` | `string` | `"auth failed: <detail>"` |

---

## REST helpers (`channels.ts`)

For talking to the HelloAgent REST API directly (not over the WebSocket). Mostly useful for OAuth flows and channel-link administration.

```typescript
import {
  HelloAgentApiError,
  // channel link
  linkChannel, listChannels, unlinkChannel,
  // OAuth code flow
  oauthAuthorize, oauthExchangeToken,
  // OAuth device flow
  oauthStartDeviceAuthorization,
  oauthApproveDeviceAuthorization,
  oauthPollDeviceToken,
} from "@helloagent/sdk";
```

### `class HelloAgentApiError extends Error`

Thrown by every REST helper on non-2xx responses. Carries the response status + JSON body when available.

| Property | Type | Notes |
|---|---|---|
| `err.status` | `number` | HTTP status |
| `err.body` | `unknown` | Parsed JSON body, or raw text |
| `err.message` | `string` | Human-readable summary |

### Channel-link

```typescript
async function linkChannel(opts: LinkChannelOptions): Promise<LinkChannelResponse>;

type LinkChannelOptions = {
  apiUrl: string;          // e.g. https://api.helloagent.cc
  jwt: string;             // user JWT
  agentName: string;       // e.g. "jarvis"
};

type LinkChannelResponse = {
  handle: string;          // bound handle, e.g. "alice/jarvis"
  token: string;           // ha_* token
  apiUrl: string;
  relayWs: string;         // WebSocket URL the agent should connect to
};

async function listChannels(apiUrl: string, jwt: string): Promise<ChannelListEntry[]>;
async function unlinkChannel(apiUrl: string, jwt: string, handle: string): Promise<void>;
```

### OAuth code flow (browser-app pattern)

```typescript
async function oauthAuthorize(opts: OAuthAuthorizeOptions): Promise<OAuthAuthorizeResponse>;
async function oauthExchangeToken(opts: OAuthTokenOptions): Promise<OAuthTokenResponse>;
```

Returns `{ token, handle, apiUrl, relayWs, … }` after the user consents in the browser. PKCE is supported via `codeVerifier`/`codeChallenge`.

### OAuth device flow (headless agents / TVs / CLI tools)

```typescript
async function oauthStartDeviceAuthorization(...): Promise<OAuthDeviceAuthorizeResponse>;
//   → { device_code, user_code, verification_uri, interval, expires_in }

async function oauthApproveDeviceAuthorization(...): Promise<OAuthDeviceApproveResponse>;
async function oauthPollDeviceToken(...): Promise<OAuthDeviceTokenResponse>;
//   → { token, handle, … } once the user approves on a separate device
```

Polling helpers handle the standard `authorization_pending` retries and back off as the spec requires.

---

## TypeScript & ESM

- Pure ESM (`"type": "module"`).
- Types ship at `dist/index.d.ts`.
- `import { Agent } from "@helloagent/sdk"` — that's the only entry point.
- Tree-shake-friendly (`"sideEffects": false`).

## Runtime support

- **Node ≥ 20.** With `ws` installed (it's an `optionalDependency`, auto-installed in Node) the SDK uses `ws` as the WebSocket transport — auto-Pongs the relay's heartbeat. Without `ws`, falls back to Node's built-in `WebSocket` but you'll see ~60s disconnect cycles. Just install `ws`.
- **Browsers.** Native `globalThis.WebSocket`. Bundlers usually mark `ws` as external automatically thanks to `optionalDependencies`.

## Errors you'll actually see

| Error | When | What to do |
|---|---|---|
| `AuthFailedError` from `onAuthFailed` | Token revoked, agent deleted, or otherwise rejected by relay | Re-pair, don't retry |
| `Error: not connected` from `agent.send` | Trying to send before WS is up | Wait for `agent.run()` to set `agent.handle` |
| `HelloAgentApiError` from REST helpers | Non-2xx response | Inspect `err.status` / `err.body` |
| `Error: websocket error` | Network drop / relay restart | Auto-handled by reconnect loop — no action needed |
| `[helloagent] connection lost: …` warnings | Transient drops | Auto-handled by reconnect loop |

## Versioning

- Pre-1.0; minor versions can adjust the protocol shape.
- Wire format itself is versioned via the relay URL path (`/v1/ws`). Bumping that is reserved for breaking wire-level changes; the SDK gets a major version too.

## See also

- [README.md](./README.md) — quickstart + reconnect walkthrough.
- [CHANGELOG.md](./CHANGELOG.md) — version history.
- Examples: [`examples/`](./examples/) (when published in this package) or [helloagent/helloagent/examples/](https://github.com/helloagent/helloagent/tree/main/examples) for the full set including Python parity.
- Plugin reference: [`@helloagent/openclaw-channel`](https://www.npmjs.com/package/@helloagent/openclaw-channel) — the OpenClaw channel plugin built on this SDK.
