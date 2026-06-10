/**
 * Test worker entry point.
 *
 * This is a separate worker entry for integration tests that excludes
 * the Sandbox DO (which requires @cloudflare/containers at runtime).
 *
 * The tests expose only the Durable Objects needed for runtime coverage.
 */

import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import type { UserKiloFacade } from '../src/kilo-facade/user-kilo-facade.js';
import {
  KILO_FACADE_AUTH_TOKEN_HEADER,
  KILO_FACADE_GLOBAL_FEED_PATH,
  KILO_FACADE_USER_ID_HEADER,
} from '../src/kilo-facade/user-kilo-facade.js';
import type {
  NotificationsBinding,
  SendCloudAgentSessionNotificationParams,
  SendCloudAgentSessionNotificationResult,
} from '../src/notifications-binding.js';
import { CloudAgentSession as RealCloudAgentSession } from '../src/persistence/CloudAgentSession';

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

export { UserKiloFacade } from '../src/kilo-facade/user-kilo-facade.js';

type TestEnv = {
  CLOUD_AGENT_SESSION: DurableObjectNamespace<CloudAgentSession>;
  CLOUD_AGENT_REPORT_QUEUE: Queue<CloudAgentQueueReport>;
  USER_KILO_FACADE: DurableObjectNamespace<UserKiloFacade>;
};

function routeToUserKiloFacade(request: Request, env: TestEnv, userId: string): Promise<Response> {
  const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(userId));
  const headers = new Headers(request.headers);
  headers.set(KILO_FACADE_USER_ID_HEADER, userId);
  headers.set(KILO_FACADE_AUTH_TOKEN_HEADER, 'test-token');
  return facade.fetch(new Request(request, { headers }));
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url);

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

    if (url.pathname.startsWith('/kilo-test/')) {
      const userId = url.searchParams.get('userId') ?? 'test_user';
      const facadeUrl = new URL(request.url);
      facadeUrl.pathname = url.pathname.slice('/kilo-test'.length);
      facadeUrl.searchParams.delete('userId');
      return routeToUserKiloFacade(new Request(facadeUrl, request), env, userId);
    }

    if (url.pathname === '/kilo-scoped-event-test') {
      const userId = url.searchParams.get('userId') ?? 'test_user';
      const kiloSessionId = url.searchParams.get('kiloSessionId');
      if (!kiloSessionId) {
        return new Response('Missing kiloSessionId parameter', { status: 400 });
      }
      const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(userId));
      return facade.openPublicSessionEventStream(kiloSessionId);
    }

    if (url.pathname === '/kilo-global-feed-test') {
      const userId = url.searchParams.get('userId') ?? 'test_user';
      const facadeUrl = new URL(request.url);
      facadeUrl.pathname = KILO_FACADE_GLOBAL_FEED_PATH;
      facadeUrl.searchParams.delete('userId');
      facadeUrl.searchParams.set('userId', userId);
      const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(userId));
      return facade.fetch(new Request(facadeUrl, request));
    }

    return new Response('Not Found', { status: 404 });
  },
};
