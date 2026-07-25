import 'server-only';

import { captureException } from '@sentry/nextjs';
import type {
  InternalDispatchLowBalanceRequest,
  InternalDispatchSecurityFindingRequest,
} from '@kilocode/notifications';
import { INTERNAL_API_SECRET, NOTIFICATIONS_WORKER_URL } from '@/lib/config.server';

type DispatchBody =
  | InternalDispatchLowBalanceRequest
  | InternalDispatchSecurityFindingRequest;

/**
 * Best-effort POST to the notifications worker internal dispatch endpoint.
 * Never rejects — missing config, network errors, and non-OK responses are
 * logged/captured and swallowed so email paths are never blocked by push.
 */
async function dispatchInternal(body: DispatchBody): Promise<void> {
  if (!NOTIFICATIONS_WORKER_URL) {
    console.error(
      '[notifications-worker-client] NOTIFICATIONS_WORKER_URL is not configured; skipping push dispatch'
    );
    return;
  }
  if (!INTERNAL_API_SECRET) {
    console.error(
      '[notifications-worker-client] INTERNAL_API_SECRET is not configured; skipping push dispatch'
    );
    return;
  }

  try {
    const response = await fetch(`${NOTIFICATIONS_WORKER_URL}/internal/v1/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Secret': INTERNAL_API_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const error = new Error(
        `Notifications worker dispatch failed: ${response.status} ${response.statusText}${
          errorText ? ` - ${errorText}` : ''
        }`
      );
      captureException(error, {
        tags: { source: 'notifications-worker-client', endpoint: 'dispatch' },
        extra: { status: response.status, kind: body.kind },
      });
    }
  } catch (error) {
    captureException(error, {
      tags: { source: 'notifications-worker-client', endpoint: 'dispatch' },
      extra: { kind: body.kind },
    });
  }
}

export async function dispatchLowBalancePush(
  input: Omit<InternalDispatchLowBalanceRequest, 'kind'>
): Promise<void> {
  await dispatchInternal({ kind: 'low_balance', ...input });
}

export async function dispatchSecurityFindingPush(
  input: Omit<InternalDispatchSecurityFindingRequest, 'kind'>
): Promise<void> {
  await dispatchInternal({ kind: 'security_finding', ...input });
}
