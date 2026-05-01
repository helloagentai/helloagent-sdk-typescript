# Changelog

All notable changes to `@helloagent/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-30

### Fixed
- **WebSocket transport stability in Node.** The SDK now prefers the [`ws`](https://www.npmjs.com/package/ws) package over Node's built-in `globalThis.WebSocket` (undici) for relay connections. Node's built-in implementation does not reliably auto-respond to server-initiated WS-protocol Ping frames, which caused the relay to tear down the agent's session every ~60s (the relay sends a Ping every 25s with a 10s pong deadline; missing two consecutive pongs trips the heartbeat). With `ws`, sessions hold open indefinitely.

### Added
- `ws` as an `optionalDependencies` entry — auto-installed in Node, ignored in browser bundles.
- `@types/ws` dev-dep + dynamic `import("ws")` with try-catch fallback to `globalThis.WebSocket`, so the SDK degrades gracefully if `ws` is unavailable for any reason.
- `engines.node: ">=20"` declaration.
- `publishConfig.access: "public"` for the scoped package.
- `prepublishOnly` script that rebuilds before `npm publish`.
- `sideEffects: false` for tree-shaking-friendly consumers.
- README with quickstart, reconnect-behavior notes, and the Node-WS rationale.
- This CHANGELOG.

### Changed
- Package metadata polish: full `repository.directory`, `bugs`, `homepage`, `keywords`, `license: MIT`.

## [0.1.0] — 2026-04-28

### Added
- Initial pre-release: `Agent`, `UserClient`, `AuthFailedError`, reconnect loop with exponential backoff, protobuf wire format.
