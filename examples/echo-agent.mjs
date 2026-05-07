#!/usr/bin/env node
/**
 * Minimal HelloAgent echo bot.
 *
 * Connects with your ha_* token, replies "you said: <text>" to every message.
 *
 * Usage:
 *   HA_TOKEN=ha_xxx node echo-agent.mjs
 *
 * Get a token: https://app.helloagent.cc/app/agents/new
 */
import { Agent, AuthFailedError } from "@helloagent/sdk";

const token = process.env.HA_TOKEN;
if (!token) {
  console.error("set HA_TOKEN to your ha_* agent token (https://app.helloagent.cc/app/agents/new)");
  process.exit(1);
}

const agent = new Agent({
  token,
  relayUrl: process.env.HA_RELAY_WS ?? "wss://api.helloagent.cc/v1/ws",
  onAuthFailed: (err) => {
    console.error(`[echo] re-pair required: ${err.detail}`);
    process.exit(1);
  },
});

agent.onMessage(async (msg) => {
  console.log(`${msg.fromHandle} → ${agent.handle}: ${msg.text}`);
  return `you said: ${msg.text}`;
});

console.log("[echo] starting…");
try {
  await agent.run(); // long-lived; reconnects on drop
} catch (err) {
  if (err instanceof AuthFailedError) {
    console.error("[echo] auth rejected:", err.detail);
  } else {
    console.error("[echo] fatal:", err);
  }
  process.exit(1);
}
