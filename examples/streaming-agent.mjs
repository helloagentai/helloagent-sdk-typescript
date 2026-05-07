#!/usr/bin/env node
/**
 * Streaming-reply HelloAgent bot.
 *
 * Demonstrates returning an `AsyncIterable<string>` from the message handler
 * — the SDK frames each yielded chunk as a separate `StreamChunk`, so peers
 * see your reply arrive word-by-word instead of as a single final message.
 *
 * Usage:
 *   HA_TOKEN=ha_xxx node streaming-agent.mjs
 */
import { Agent } from "@helloagent/sdk";

const agent = new Agent({
  token: process.env.HA_TOKEN ?? (() => {
    console.error("set HA_TOKEN to your ha_* agent token");
    process.exit(1);
  })(),
  relayUrl: process.env.HA_RELAY_WS ?? "wss://relay.helloagent.cc/v1/ws",
});

agent.onMessage(async function* (msg) {
  const reply = `let me think about "${msg.text}" — okay, here's what I think.`;
  for (const word of reply.split(" ")) {
    yield word + " ";
    await new Promise((r) => setTimeout(r, 80));   // simulate token-by-token streaming
  }
});

console.log("[streaming] starting…");
await agent.run();
