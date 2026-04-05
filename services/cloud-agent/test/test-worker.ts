/**
 * Test worker entry point.
 *
 * This is a separate worker entry for integration tests that excludes
 * the Sandbox DO (which requires @cloudflare/containers at runtime).
 *
 * The tests only need CloudAgentSession for WebSocket/queue testing.
 * This worker intentionally does NOT import any queue consumer code
 * to avoid the @cloudflare/sandbox import chain.
 *
 * The queue handler here is a minimal stub - tests that need to verify
 * queue behavior should use DO methods directly via runInDurableObject.
 */

import type { CloudAgentSession } from '../src/persistence/CloudAgentSession.js';

// Re-export CloudAgentSession for DO binding
export { CloudAgentSession } from '../src/persistence/CloudAgentSession';

// Minimal Env type for tests
type TestEnv = {
  CLOUD_AGENT_SESSION: DurableObjectNamespace<CloudAgentSession>;
  EXECUTION_QUEUE: Queue;
};

// Minimal ExecutionMessage type (subset of ../src/queue/types.ts)
// We define it inline to avoid any imports that could chain to sandbox
type ExecutionMessage = {
  executionId: string;
  sessionId: string;
  userId: string;
  mode: string;
  prompt: string;
  sandboxId: string;
};

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url);

    // Handle /stream WebSocket endpoint
    if (url.pathname === '/stream') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const sessionId = url.searchParams.get('sessionId');
      const userId = url.searchParams.get('userId') ?? 'test_user';

      if (!sessionId) {
        return new Response('Missing sessionId parameter', { status: 400 });
      }

      const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
      const stub = env.CLOUD_AGENT_SESSION.get(doId);

      return stub.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },

  async queue(
    batch: MessageBatch<ExecutionMessage>,
    _env: TestEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    // Stub queue handler - just ack all messages
    // Tests that need to verify queue behavior should use DO methods
    // directly via runInDurableObject instead
    for (const message of batch.messages) {
      message.ack();
    }
  },
};
