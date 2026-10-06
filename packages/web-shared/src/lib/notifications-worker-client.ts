import 'server-only';

import { captureException } from '@sentry/nextjs';
import {
  sendPushForConversationOutputSchema,
  type GlanceableScopeRefreshRequest,
  type InternalDispatchLowBalanceRequest,
  type InternalDispatchSecurityFindingRequest,
  type InternalDispatchSecurityLifecycleRequest,
  type InternalDispatchSpendAlertRequest,
} from '@kilocode/notifications';
import {
  INTERNAL_API_SECRET,
  NOTIFICATIONS_WORKER_URL,
} from '@kilocode/web-shared/lib/config.server';

type DispatchBody =
  | InternalDispatchLowBalanceRequest
  | InternalDispatchSecurityFindingRequest
  | InternalDispatchSecurityLifecycleRequest
  | InternalDispatchSpendAlertRequest;

/**
 * In-call retry schedule (exponential backoff) for a dispatch the worker
 * answered 200 but reported failed recipients for. Bounded so the spend-alert
 * drain's lease is never held long, and deliberately short: the outbox's own
 * backoff remains the outer retry loop.
 */
const DISPATCH_RETRY_DELAYS_MS = [1_000, 4_000];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Best-effort POST to the notifications worker internal dispatch endpoint.
 * Never rejects — missing config, network errors, and non-OK responses are
 * logged/captured and swallowed so email paths are never blocked by push — and
 * returns whether the worker accepted the dispatch, which the spend-alert
 * outbox uses to decide whether to retry. A 2xx whose body reports a failed
 * recipient is a refused dispatch, not an accepted one: the worker answers 200
 * with a per-recipient breakdown even when a send failed.
 *
 * Sentry only hears about a dispatch worth acting on: every recipient of a
 * multi-recipient dispatch failed at once, or a failure that survived the
 * bounded in-call retry. A partial failure that a retry delivered is a
 * structured warning, never an alert.
 */
async function dispatchInternal(body: DispatchBody): Promise<boolean> {
  if (!NOTIFICATIONS_WORKER_URL) {
    console.error(
      '[notifications-worker-client] NOTIFICATIONS_WORKER_URL is not configured; skipping push dispatch'
    );
    return false;
  }
  if (!INTERNAL_API_SECRET) {
    console.error(
      '[notifications-worker-client] INTERNAL_API_SECRET is not configured; skipping push dispatch'
    );
    return false;
  }

  // A 2xx is not by itself an accepted dispatch. The worker answers 200 with
  // a per-recipient breakdown, and a recipient whose preference read threw,
  // whose DO call rejected, or whose push the DO could not deliver is reported
  // as `failed` inside that body rather than as an HTTP status. The spend-alert
  // outbox retries on this boolean, so any failed recipient means the dispatch
  // was refused. A body that does not parse keeps the previous reading of an
  // accepted dispatch.
  try {
    for (let attempt = 0; ; attempt++) {
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
        return false;
      }

      const payload: unknown = await response.json().catch(() => null);
      const parsed = sendPushForConversationOutputSchema.safeParse(payload);
      const totalRecipients = parsed.success ? parsed.data.perRecipient.length : 0;
      const failedCount = parsed.success
        ? parsed.data.perRecipient.filter(recipient => recipient.outcome === 'failed').length
        : 0;
      if (failedCount === 0) {
        return true;
      }

      // A retry re-POSTs the same body and is safe under the channel DO's
      // idempotency record: a recipient already delivered answers `duplicate`,
      // and one whose Expo ticket failure was terminal (an invalid or expired
      // push token) recorded `failed` and also answers `duplicate`. These
      // dispatch kinds are badge-less and set no rate limit, so the DO writes
      // no `pending` marker for them and a transient failure left no record at
      // all — the retry simply re-sends it, which is what the retry is for.
      //
      // Every recipient of a multi-recipient dispatch failing at once points
      // at the worker or Expo rather than one transient send, so it alerts on
      // the first response. A single-recipient failure is indistinguishable
      // from one transient send and falls through to the bounded retry below;
      // if the failure was terminal, the retry answers `duplicate` and the
      // dispatch is accepted without alerting.
      if (totalRecipients > 1 && failedCount === totalRecipients) {
        const error = new Error(
          `Notifications worker dispatch failed for all ${totalRecipients} recipients`
        );
        captureException(error, {
          tags: { source: 'notifications-worker-client', endpoint: 'dispatch' },
          extra: { kind: body.kind, failedRecipients: failedCount, totalRecipients },
        });
        return false;
      }

      const retryDelay = DISPATCH_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) {
        const error = new Error(
          `Notifications worker dispatch failed for ${failedCount} recipient${failedCount === 1 ? '' : 's'} after ${attempt + 1} attempts`
        );
        captureException(error, {
          tags: { source: 'notifications-worker-client', endpoint: 'dispatch' },
          extra: {
            kind: body.kind,
            failedRecipients: failedCount,
            totalRecipients,
            attempts: attempt + 1,
          },
        });
        return false;
      }

      // A failure that a retry may still deliver is logged, not captured: a
      // single transient recipient failure must not page anyone.
      console.warn('[notifications-worker-client] dispatch failed for some recipients; retrying', {
        kind: body.kind,
        failedRecipients: failedCount,
        totalRecipients,
        attempt: attempt + 1,
      });
      await sleep(retryDelay);
    }
  } catch (error) {
    captureException(error, {
      tags: { source: 'notifications-worker-client', endpoint: 'dispatch' },
      extra: { kind: body.kind },
    });
    return false;
  }
}

export async function dispatchLowBalancePush(
  input: Omit<InternalDispatchLowBalanceRequest, 'kind'>
): Promise<void> {
  await dispatchInternal({ kind: 'low_balance', ...input });
}

/**
 * Dispatches a spend-alert push. Unlike the email-backed dispatchers above,
 * this exposes the worker's acceptance so the spend-alert delivery drain can
 * reschedule a dispatch the worker refused instead of marking it delivered.
 * It still never rejects.
 */
export async function dispatchSpendAlertPush(
  input: Omit<InternalDispatchSpendAlertRequest, 'kind'>
): Promise<boolean> {
  return dispatchInternal({ kind: 'spend_alert', ...input });
}

export async function dispatchSecurityFindingPush(
  input: Omit<InternalDispatchSecurityFindingRequest, 'kind'>
): Promise<void> {
  await dispatchInternal({ kind: 'security_finding', ...input });
}

export async function dispatchSecurityLifecyclePush(
  input: Omit<InternalDispatchSecurityLifecycleRequest, 'kind'>
): Promise<void> {
  await dispatchInternal({ kind: 'security_lifecycle', ...input });
}

/**
 * Ask the notifications worker to rebuild and re-deliver the glanceable
 * snapshot for one scope.
 *
 * Registering a replacement iOS activity token retires the previous live
 * `ios_activity` row, and only a delivery pass sends a retired token its `end`.
 * Those passes are otherwise driven by agent-session transitions, so without
 * this request an abandoned Lock Screen card waits on the next transition —
 * during a long-running task, minutes — and stays stacked under the new card.
 *
 * Best-effort like the dispatchers above: missing config, a network error, and
 * a non-OK response are logged/captured and swallowed. The registration that
 * retired the row has already committed, so a notification failure must never
 * fail it; the row stays retired and the next scheduled refresh still ends the
 * card.
 */
export async function refreshGlanceableScope(input: GlanceableScopeRefreshRequest): Promise<void> {
  if (!NOTIFICATIONS_WORKER_URL) {
    console.error(
      '[notifications-worker-client] NOTIFICATIONS_WORKER_URL is not configured; skipping glanceable refresh'
    );
    return;
  }
  if (!INTERNAL_API_SECRET) {
    console.error(
      '[notifications-worker-client] INTERNAL_API_SECRET is not configured; skipping glanceable refresh'
    );
    return;
  }

  try {
    const response = await fetch(`${NOTIFICATIONS_WORKER_URL}/internal/v1/glanceable-refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Secret': INTERNAL_API_SECRET,
      },
      body: JSON.stringify(input),
      // The registration mutation awaits this. The worker's refresh is one
      // snapshot fetch plus parallel APNs sends, so 10s is generous; past it
      // the retired row is still superseded and the next refresh ends the card,
      // and the shorter bound keeps a hung worker from holding the caller's
      // token-mutation queue.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const error = new Error(
        `Notifications worker glanceable refresh failed: ${response.status} ${response.statusText}${
          errorText ? ` - ${errorText}` : ''
        }`
      );
      captureException(error, {
        tags: { source: 'notifications-worker-client', endpoint: 'glanceable-refresh' },
        extra: { status: response.status },
      });
    }
  } catch (error) {
    captureException(error, {
      tags: { source: 'notifications-worker-client', endpoint: 'glanceable-refresh' },
    });
  }
}
