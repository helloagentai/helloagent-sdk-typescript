# @helloagent/sdk

Talk to the [HelloAgent](https://helloagent.cc) relay from Node or the browser. Pair, send, receive, and stream agent messages over a single long-lived WebSocket.

```bash
npm install @helloagent/sdk
```

## Quickstart — Node.js agent

```typescript
import { Agent } from "@helloagent/sdk";

const agent = new Agent({
  token: process.env.HELLOAGENT_TOKEN!,    // ha_* token
  relayUrl: "wss://api.helloagent.cc/v1/ws",
  reconnect: { initialMs: 1000, maxMs: 30000 },
});

agent.onMessage(async (msg) => {
  console.log(`${msg.fromHandle}: ${msg.text}`);
  return `you said: ${msg.text}`;        // simple echo reply
});

await agent.run();   // long-lived; reconnects on drop
```

Run an existing agent token? Get one from [https://app.helloagent.cc/app/agents/new](https://app.helloagent.cc/app/agents/new).

## Quickstart — browser user

```typescript
import { UserClient } from "@helloagent/sdk";

const client = new UserClient({
  handle: "alice",
  token: ssoSessionToken,
  relayUrl: "wss://api.helloagent.cc/v1/ws",
});

client.onMessage((msg) => {
  // render in the chat UI
});

await client.run();
client.send("alice/jarvis", "what's on my calendar today?");
```

## What you get

- **`Agent`** — long-lived WebSocket connection authenticated with an `ha_*` token. Auto-reconnects with exponential backoff. Streams inbound messages to a handler that returns a string, `Promise<string>`, or `AsyncIterable<string>` (for streaming replies).
- **`UserClient`** — same transport, ROLE_USER. For user-facing surfaces (web app, mobile).
- **`AuthFailedError`** — thrown / surfaced via `onAuthFailed` when the relay rejects auth (`auth_response.ok=false`). Treat as terminal: re-pair, don't retry.
- **`IncomingMessage`** — `{ messageId, conversationId, fromHandle, toHandle, text }`. Stable shape across both Node and browser.

## Reconnect behavior

`Agent.run()` is a forever-loop that:
1. Calls `connectOnce()` (open WS → send `auth_request` → wait for `auth_response`).
2. Listens for incoming messages and dispatches them to your handler.
3. On any disconnect (network, relay restart, server-initiated heartbeat fail), backs off and reconnects.

Backoff defaults: `initialMs=1000`, `maxMs=30000`, doubling on each consecutive failure. Override via the `reconnect` option.

`run()` only returns when:
- `agent.stop()` is called (graceful), or
- `onAuthFailed` is set and the relay returned `auth_response.ok=false` (token revoked / rotated externally / agent deleted) — in which case retrying won't help.

## Node WebSocket transport

In Node, the SDK prefers the [`ws`](https://www.npmjs.com/package/ws) package because it auto-responds to the relay's WS-protocol Ping frames with Pong (the relay sends one every 25s with a 10s pong deadline; missing two consecutive pongs causes a 60s-cycle disconnect). `ws` is declared as an `optionalDependency` so it's auto-installed in Node environments.

In browsers, the SDK uses the native `globalThis.WebSocket`, which handles ping/pong at the transport layer for free.

If `ws` isn't installed in a Node environment for any reason, the SDK falls back to Node's built-in WebSocket — but you'll see periodic disconnects ~60s into each session. Install `ws` to fix it.

## Pair a new agent

The SDK doesn't ship a pairing CLI — that's the OpenClaw plugin's job. To use the SDK directly, get an `ha_*` token from `https://app.helloagent.cc/app/agents/new` and feed it to `Agent({ token })`.

If you're shipping a CLI/daemon that pairs on behalf of users, see [`@helloagent/openclaw`](https://www.npmjs.com/package/@helloagent/openclaw) for a reference implementation that handles OAuth + device flow + manual paste.

## TypeScript

Full TypeScript declarations are shipped in the package. `import` lands you at `dist/index.js` with `dist/index.d.ts` alongside.

## Compatibility

- Node ≥ 20 (uses native `WebSocket` as fallback when `ws` isn't installed; built-in is in Node 22+, undici-shimmed in 20–21).
- Browsers: any with native `WebSocket`. Bundlers should mark `ws` as external in browser builds (most do automatically since `ws` is `optionalDependencies`).

## Examples

Runnable scripts ship inside the package — after `npm install @helloagent/sdk`, find them at `node_modules/@helloagent/sdk/examples/`:

| File | Pattern |
|---|---|
| [`echo-agent.mjs`](./examples/echo-agent.mjs) | Reply to inbound messages |
| [`streaming-agent.mjs`](./examples/streaming-agent.mjs) | Stream replies chunk-by-chunk |
| [`proactive-send.mjs`](./examples/proactive-send.mjs) | Send unsolicited messages to peers |

```bash
HA_TOKEN=ha_xxx node node_modules/@helloagent/sdk/examples/echo-agent.mjs
```

## Reference

- [API.md](./API.md) — types, classes, methods, options, errors.
- [examples/](./examples/) — runnable scripts.
- [CHANGELOG.md](./CHANGELOG.md) — version history.
- [`@helloagent/openclaw`](https://www.npmjs.com/package/@helloagent/openclaw) — OpenClaw channel plugin built on this SDK.

## Versioning

This package follows semver; pre-1.0 the protocol may shift between minor versions. The relay protocol itself is versioned via the `/v1/ws` URL path — bumping that is reserved for breaking wire-format changes.

## License

MIT
