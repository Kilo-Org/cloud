/**
 * Test worker entry point.
 *
 * This is a separate worker entry for integration tests that excludes
 * the Sandbox DO (which requires @cloudflare/containers at runtime).
 *
 * The tests only need CloudAgentSession for WebSocket testing.
 * This worker intentionally does NOT import any sandbox-related code
 * to avoid the @cloudflare/sandbox import chain.
 */

import type { CloudAgentSession } from '../src/persistence/CloudAgentSession.js';

// Re-export CloudAgentSession for DO binding
export { CloudAgentSession } from '../src/persistence/CloudAgentSession';

// Minimal Env type for tests
type TestEnv = {
  CLOUD_AGENT_SESSION: DurableObjectNamespace<CloudAgentSession>;
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
};
