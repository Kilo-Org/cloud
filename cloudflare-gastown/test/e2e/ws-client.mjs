#!/usr/bin/env node
/**
 * WebSocket test client for E2E tests.
 * Usage: node ws-client.mjs <url> [timeout_seconds] [subscribe_agent_id]
 *
 * Connects to the WebSocket, optionally subscribes to an agent,
 * collects all messages received within the timeout, and prints them as JSON array to stdout.
 * Exits with 0 if at least one message was received, 1 otherwise.
 */

const url = process.argv[2];
const timeoutSec = parseInt(process.argv[3] || '15', 10);
const subscribeAgentId = process.argv[4] || null;

if (!url) {
  console.error('Usage: node ws-client.mjs <url> [timeout_seconds] [subscribe_agent_id]');
  process.exit(2);
}

const messages = [];
let ws;

try {
  ws = new WebSocket(url);
} catch (err) {
  console.error(`Failed to create WebSocket: ${err.message}`);
  process.exit(1);
}

ws.onopen = () => {
  process.stderr.write(`[ws-client] Connected to ${url}\n`);
  if (subscribeAgentId) {
    ws.send(JSON.stringify({ type: 'subscribe', agentId: subscribeAgentId }));
    process.stderr.write(`[ws-client] Subscribed to agent ${subscribeAgentId}\n`);
  }
};

ws.onmessage = event => {
  const data = typeof event.data === 'string' ? event.data : event.data.toString();
  process.stderr.write(`[ws-client] Received: ${data.slice(0, 200)}\n`);
  try {
    messages.push(JSON.parse(data));
  } catch {
    messages.push({ raw: data });
  }
};

ws.onerror = event => {
  process.stderr.write(`[ws-client] Error: ${event.message || 'unknown'}\n`);
};

ws.onclose = event => {
  process.stderr.write(`[ws-client] Closed: code=${event.code} reason=${event.reason}\n`);
};

// Timeout: print collected messages and exit
setTimeout(() => {
  process.stderr.write(
    `[ws-client] Timeout (${timeoutSec}s), collected ${messages.length} messages\n`
  );
  console.log(JSON.stringify(messages));
  if (ws.readyState === WebSocket.OPEN) ws.close();
  process.exit(messages.length > 0 ? 0 : 1);
}, timeoutSec * 1000);
