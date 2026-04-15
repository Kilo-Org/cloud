#!/usr/bin/env npx tsx
/**
 * End-to-end test script for kilo-chat service (user-only HTTP flow).
 *
 * Bots no longer have a public HTTP surface on kilo-chat — they reach the
 * service via service-binding RPC from the kiloclaw worker, not HTTP. This
 * script exercises only the human-user HTTP path (JWT-authenticated).
 *
 * Prerequisites:
 *   1. kilo-chat running: cd services/kilo-chat && wrangler dev
 *   2. .dev.vars configured with NEXTAUTH_SECRET, etc.
 *   3. (For full agent loop) kiloclaw running with kilo-chat plugin
 *
 * Usage:
 *   npx tsx services/kilo-chat/scripts/e2e-test.ts
 *
 * Environment variables:
 *   KILO_CHAT_URL       - kilo-chat base URL (default: http://localhost:8802)
 *   NEXTAUTH_SECRET     - JWT signing secret (must match .dev.vars)
 *   SANDBOX_ID          - sandbox ID for the bot member (default: e2e-test-sandbox)
 *   TIMEOUT_MS          - how long to wait for agent response (default: 30000)
 */

import { SignJWT } from 'jose';

const BASE_URL = process.env.KILO_CHAT_URL ?? 'http://localhost:8802';
const JWT_SECRET = process.env.NEXTAUTH_SECRET;
const SANDBOX_ID = process.env.SANDBOX_ID ?? 'e2e-test-sandbox';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? '30000');

if (!JWT_SECRET) {
  console.error('NEXTAUTH_SECRET is required (must match kilo-chat .dev.vars)');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function signUserToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    kiloUserId: userId,
    apiTokenPepper: null,
    version: 3,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

async function userHeaders(token: string): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const userId = `test-user-${Date.now()}`;
  const userToken = await signUserToken(userId);
  const headers = await userHeaders(userToken);

  console.log(`\n🔑 User: ${userId}`);
  console.log(`🤖 Bot: bot:kiloclaw:${SANDBOX_ID}`);
  console.log(`🌐 Base URL: ${BASE_URL}\n`);

  // 1. Create conversation
  console.log('── Step 1: Create conversation ──');
  const createRes = await fetch(`${BASE_URL}/v1/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sandboxId: SANDBOX_ID, title: 'E2E Test' }),
  });

  if (!createRes.ok) {
    console.error('Failed to create conversation:', createRes.status, await createRes.text());
    process.exit(1);
  }

  const { conversationId } = (await createRes.json()) as { conversationId: string };
  console.log(`✓ Created conversation: ${conversationId}\n`);

  // 2. Connect SSE
  console.log('── Step 2: Connect SSE ──');
  const sseRes = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/events`, {
    headers: { authorization: `Bearer ${userToken}` },
  });

  if (!sseRes.ok || !sseRes.body) {
    console.error('Failed to connect SSE:', sseRes.status);
    process.exit(1);
  }

  console.log('✓ SSE connected\n');

  // Start reading SSE events in the background
  const events: Array<{ event: string; data: unknown }> = [];
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  const readLoop = (async () => {
    while (!done) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      // Parse SSE events from buffer
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (part.startsWith(':')) continue; // ping
        const lines = part.split('\n');
        let eventName = '';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventName = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (eventName && data) {
          const parsed = JSON.parse(data);
          events.push({ event: eventName, data: parsed });
          console.log(`  📨 SSE: ${eventName}`, JSON.stringify(parsed, null, 2));
        }
      }
    }
  })();

  // 3. Send message as user
  console.log('── Step 3: Send message ──');
  const message = 'Hello! What is 2 + 2?';
  const msgRes = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversationId,
      content: [{ type: 'text', text: message }],
    }),
  });

  if (!msgRes.ok) {
    console.error('Failed to send message:', msgRes.status, await msgRes.text());
    process.exit(1);
  }

  const { messageId, version } = (await msgRes.json()) as { messageId: string; version: number };
  console.log(`✓ Sent message: "${message}" (id: ${messageId}, v${version})\n`);

  // 4. Wait for agent response
  console.log(`── Step 4: Waiting for agent response (${TIMEOUT_MS / 1000}s timeout) ──`);
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const botMessage = events.find(
      e =>
        e.event === 'message.created' &&
        (e.data as { senderId?: string }).senderId?.startsWith('bot:')
    );
    if (botMessage) {
      console.log(`\n✓ Agent responded!`);
      console.log(JSON.stringify(botMessage.data, null, 2));
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (
    !events.find(
      e =>
        e.event === 'message.created' &&
        (e.data as { senderId?: string }).senderId?.startsWith('bot:')
    )
  ) {
    console.log('\n⏰ Timeout — no agent response received.');
    console.log(
      'This is expected if kiloclaw is not running or webhook delivery is not configured.'
    );
    console.log(`\nReceived ${events.length} SSE events total:`);
    for (const e of events) {
      console.log(`  - ${e.event}`);
    }
  }

  // 5. List messages
  console.log('\n── Step 5: List messages ──');
  const listRes = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages?limit=10`, {
    headers: { authorization: `Bearer ${userToken}` },
  });
  const { messages } = (await listRes.json()) as {
    messages: Array<{ id: string; senderId: string; content: string }>;
  };
  console.log(`${messages.length} message(s) in conversation:`);
  for (const m of messages) {
    const content = JSON.parse(m.content);
    const text = content.find((b: { type: string }) => b.type === 'text')?.text ?? '(no text)';
    console.log(`  [${m.senderId}]: ${text}`);
  }

  // Cleanup
  done = true;
  reader.cancel();
  await readLoop.catch(() => {});

  console.log('\n✓ Done!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
