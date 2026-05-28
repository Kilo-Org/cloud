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

import { CloudAgentSession as RealCloudAgentSession } from '../src/persistence/CloudAgentSession';
import type {
  NotificationsBinding,
  SendCloudAgentSessionNotificationParams,
  SendCloudAgentSessionNotificationResult,
} from '../src/notifications-binding.js';

type RecordedPushCall = SendCloudAgentSessionNotificationParams;

const recordedNotificationCalls: RecordedPushCall[] = [];
let remainingNotificationDispatchFailures = 0;

// In the Workers test runtime, we don't want to actually provision the real
// notifications service binding. Swap it with an in-memory stub that records
// every RPC call so integration tests can assert on dispatches.
function createNotificationsStub(): NotificationsBinding {
  const noopFetcher: Fetcher = {
    // Minimal Fetcher surface — tests never invoke fetch() on this stub.
    fetch: () => Promise.resolve(new Response('', { status: 501 })),
    connect: () => {
      throw new Error('connect not implemented on test notifications stub');
    },
  } as Fetcher;

  return {
    ...noopFetcher,
    async sendCloudAgentSessionNotification(
      params: SendCloudAgentSessionNotificationParams
    ): Promise<SendCloudAgentSessionNotificationResult> {
      recordedNotificationCalls.push(params);
      if (remainingNotificationDispatchFailures > 0) {
        remainingNotificationDispatchFailures -= 1;
        return { dispatched: false, reason: 'dispatch_failed' };
      }
      return { dispatched: true };
    },
  } satisfies NotificationsBinding;
}

const notificationsStub = createNotificationsStub();

// Re-export CloudAgentSession with the service binding replaced by the stub
// so tests observe push dispatches without requiring the real Worker.
export class CloudAgentSession extends RealCloudAgentSession {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, NOTIFICATIONS: notificationsStub });
  }
}

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

    if (url.pathname === '/test/notification-jobs/fail-next' && request.method === 'POST') {
      remainingNotificationDispatchFailures += 1;
      return Response.json({ ok: true });
    }

    if (url.pathname === '/test/notification-jobs') {
      if (request.method === 'DELETE') {
        recordedNotificationCalls.length = 0;
        remainingNotificationDispatchFailures = 0;
        return Response.json({ ok: true });
      }
      return Response.json([...recordedNotificationCalls]);
    }

    return new Response('Not Found', { status: 404 });
  },
};
