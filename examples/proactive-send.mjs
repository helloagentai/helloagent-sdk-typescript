#!/usr/bin/env node
/**
 * Proactive-send example.
 *
 * Connects, waits for the relay to bind the handle, then sends an unsolicited
 * message to a peer (instead of just replying to inbound messages). Useful
 * for cron-style notifications, status pings, etc.
 *
 * Usage:
 *   HA_TOKEN=ha_xxx PEER=alice node proactive-send.mjs
 */
import { Agent } from "@helloagentai/sdk";

const token = process.env.HA_TOKEN;
const peer = process.env.PEER;
if (!token || !peer) {
  console.error("set HA_TOKEN (your ha_* token) and PEER (target handle, e.g. 'alice')");
  process.exit(1);
}

const agent = new Agent({
  token,
  relayUrl: process.env.HA_RELAY_WS ?? "wss://api.helloagent.cc/v1/ws",
});

// Long-lived run loop — must be running for sends to work.
agent.run().catch((err) => {
  console.error("[proactive] run loop failed:", err);
  process.exit(1);
});

// Wait until the relay binds our handle (auth_response).
const deadline = Date.now() + 10_000;
while (Date.now() < deadline && !agent.handle) {
  await new Promise((r) => setTimeout(r, 50));
}
if (!agent.handle) {
  console.error("[proactive] handle not resolved within 10s; check token + relay URL");
  process.exit(1);
}
console.log(`[proactive] connected as ${agent.handle}; sending to ${peer}…`);

const messageId = agent.send(peer, `hello from ${agent.handle} at ${new Date().toISOString()}`);
console.log(`[proactive] sent messageId=${messageId}`);

// Stay alive briefly so the send completes; in a real script you'd keep
// running indefinitely and respond to inbound replies.
await new Promise((r) => setTimeout(r, 2000));
agent.stop();
