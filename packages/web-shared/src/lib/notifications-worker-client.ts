import 'server-only';

import { captureException } from '@sentry/nextjs';
import {
  internalDispatchResponseSchema,
  type GlanceableScopeRefreshRequest,
  type InternalDispatchAccountSecurityRequest,
  type InternalDispatchAgentBriefingRequest,
  type InternalDispatchLowBalanceRequest,
  type InternalDispatchRequest,
  type InternalDispatchSecurityFindingRequest,
  type InternalDispatchSecurityLifecycleRequest,
  type InternalDispatchSpendAlertRequest,
} from '@kilocode/notifications/schemas';
import { STS_NOTIFICATIONS_INTERNAL_CALL } from '@kilocode/sts-contracts';
import {
  NOTIFICATIONS_SENDER_AUTH,
  NOTIFICATIONS_WORKER_URL,
} from '@kilocode/web-shared/lib/config.server';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import { parseInternalServiceEndpoint } from '@kilocode/web-shared/lib/internal-service-url';
import {
  resolveServiceSenderAuth,
  serviceSenderHeaders,
  type ServiceSenderAuth,
} from '@kilocode/web-shared/lib/service-sender-auth';

type InternalWorkerEndpointSpec = {
  /** Absolute path of the route on the notifications worker. */
  path: string;
  /** Completes the `; skipping ...` phrase of each configuration-skip log line. */
  skipSubject: string;
  /** Prefix of the `Error` built for a non-OK response. */
  failureLabel: string;
  /** The Sentry `endpoint` tag value. */
  tag: string;
};

const DISPATCH_ENDPOINT: InternalWorkerEndpointSpec = {
  path: '/internal/v1/dispatch',
  skipSubject: 'push dispatch',
  failureLabel: 'Notifications worker dispatch failed',
  tag: 'dispatch',
};

const GLANCEABLE_REFRESH_ENDPOINT: InternalWorkerEndpointSpec = {
  path: '/internal/v1/glanceable-refresh',
  skipSubject: 'glanceable refresh',
  failureLabel: 'Notifications worker glanceable refresh failed',
  tag: 'glanceable-refresh',
};

type InternalWorkerEndpoint = {
  url: URL;
  credential: Record<string, string>;
  failureLabel: string;
};

const resolvedNotificationsSender = resolveServiceSenderAuth({
  auth: NOTIFICATIONS_SENDER_AUTH,
  url: NOTIFICATIONS_WORKER_URL,
  runtime: process.env,
});

/**
 * `NOTIFICATIONS_SENDER_AUTH` (`service-sender-auth.ts`), the credential of both internal routes:
 * `legacy` sends the internal API secret in `X-Internal-Secret`, as before (also when unset);
 * explicit `sts` sends only a `notifications:internal.call` STS token, never following a redirect.
 * The Worker admits only the `web` workload, so an ai-gateway build (its low-balance pushes come
 * through here; `next.config.mjs` inlines `KILO_STS_WORKLOAD`) refuses `sts` and sends nothing.
 */
const notificationsSender: ServiceSenderAuth =
  resolvedNotificationsSender.kind === 'sts' && process.env.KILO_STS_WORKLOAD !== undefined
    ? { kind: 'refused', reason: 'not_web_workload' }
    : resolvedNotificationsSender;

type InternalPostResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; error: Error };

/**
 * Resolves one worker endpoint behind its three configuration gates, in the
 * order the worker's logs and tests expect: a configured base URL, a base URL
 * that parses as https or loopback http, then its credential. Returns `null`
 * after logging which gate skipped the call, or after capturing a credential
 * that could not be read (a rejected secret read, a refused switch, no STS
 * token), so the caller only has to return its never-rejects value.
 */
async function resolveInternalWorkerEndpoint(
  spec: InternalWorkerEndpointSpec
): Promise<InternalWorkerEndpoint | null> {
  if (!NOTIFICATIONS_WORKER_URL) {
    console.error(
      `[notifications-worker-client] NOTIFICATIONS_WORKER_URL is not configured; skipping ${spec.skipSubject}`
    );
    return null;
  }
  const url = parseInternalServiceEndpoint(NOTIFICATIONS_WORKER_URL, spec.path);
  if (!url) {
    console.error(
      `[notifications-worker-client] NOTIFICATIONS_WORKER_URL is not an https or loopback http endpoint; skipping ${spec.skipSubject}`
    );
    return null;
  }
  let credential: Record<string, string>;
  try {
    credential = await serviceSenderHeaders({
      sender: notificationsSender,
      variable: 'NOTIFICATIONS_SENDER_AUTH',
      label: 'notifications worker client',
      request: STS_NOTIFICATIONS_INTERNAL_CALL,
      legacyHeaders: async () => ({ 'X-Internal-Secret': await readInternalApiSecret() }),
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'notifications-worker-client', endpoint: spec.tag },
    });
    return null;
  }
  // Only the legacy credential carries the header; an empty secret skips the call, as before.
  if (credential['X-Internal-Secret'] === '') {
    console.error(
      `[notifications-worker-client] INTERNAL_API_SECRET is not configured; skipping ${spec.skipSubject}`
    );
    return null;
  }
  return { url, credential, failureLabel: spec.failureLabel };
}

/**
 * One POST attempt against a resolved worker endpoint. A non-OK response
 * becomes a labelled `Error` for the caller to capture; a network or abort
 * rejection propagates so the caller's `catch` still sees it.
 */
async function postInternal(
  endpoint: InternalWorkerEndpoint,
  body: InternalDispatchRequest | GlanceableScopeRefreshRequest,
  { timeoutMs, headers = {} }: { timeoutMs: number; headers?: Record<string, string> }
): Promise<InternalPostResult> {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...endpoint.credential,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  };
  // An STS token is for this origin only; a redirect never carries it on.
  if (notificationsSender.kind === 'sts') init.redirect = 'error';
  const response = await fetch(endpoint.url.toString(), init);

  if (response.ok) {
    return { ok: true, response };
  }

  const errorText = await response.text().catch(() => '');
  return {
    ok: false,
    status: response.status,
    error: new Error(
      `${endpoint.failureLabel}: ${response.status} ${response.statusText}${
        errorText ? ` - ${errorText}` : ''
      }`
    ),
  };
}

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
async function dispatchInternal(body: InternalDispatchRequest): Promise<boolean> {
  const endpoint = await resolveInternalWorkerEndpoint(DISPATCH_ENDPOINT);
  if (!endpoint) {
    return false;
  }

  // A 2xx is not by itself an accepted dispatch. The worker answers 200 with
  // a per-recipient breakdown, and a recipient whose preference read threw,
  // whose DO call rejected, or whose push the DO could not deliver is reported
  // as `failed` inside that body rather than as an HTTP status. The spend-alert
  // outbox retries on this boolean, so any failed recipient means the dispatch
  // was refused. A body that does not parse keeps the previous reading of an
  // accepted dispatch.
  //
  // One dispatch id per call lets worker-side logs correlate with the
  // client-side warning/capture for the same dispatch. Context stays free of
  // recipient identifiers: counts and stable failure reasons only.
  const dispatchId = crypto.randomUUID();
  const tags = {
    source: 'notifications-worker-client',
    endpoint: DISPATCH_ENDPOINT.tag,
    kind: body.kind,
  };
  try {
    for (let attempt = 0; ; attempt++) {
      const result = await postInternal(endpoint, body, {
        timeoutMs: 30_000,
        headers: { 'X-Dispatch-Id': dispatchId },
      });

      if (!result.ok) {
        captureException(result.error, {
          tags,
          extra: { status: result.status, kind: body.kind, dispatchId, attempt: attempt + 1 },
        });
        return false;
      }

      const payload: unknown = await result.response.json().catch(() => null);
      const parsed = internalDispatchResponseSchema.safeParse(payload);
      const failed = parsed.success
        ? parsed.data.perRecipient.filter(recipient => recipient.outcome === 'failed')
        : [];
      const totalRecipients = parsed.success ? parsed.data.perRecipient.length : 0;
      const failedCount = failed.length;
      if (failedCount === 0) {
        return true;
      }

      // Failure reasons come from the worker as stable tokens; aggregate them
      // so the context carries the failure shape without any recipient id.
      const failureReasons: Record<string, number> = {};
      for (const recipient of failed) {
        const reason = recipient.reason ?? 'unknown';
        failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
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
          tags: { ...tags, failure_scope: 'all' },
          extra: {
            kind: body.kind,
            dispatchId,
            failedRecipients: failedCount,
            totalRecipients,
            failureReasons,
          },
        });
        return false;
      }

      const retryDelay = DISPATCH_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) {
        const error = new Error(
          `Notifications worker dispatch failed for ${failedCount} recipient${failedCount === 1 ? '' : 's'} after ${attempt + 1} attempts`
        );
        captureException(error, {
          tags: { ...tags, failure_scope: 'partial' },
          extra: {
            kind: body.kind,
            dispatchId,
            failedRecipients: failedCount,
            totalRecipients,
            failureReasons,
            attempts: attempt + 1,
          },
        });
        return false;
      }

      // A failure that a retry may still deliver is logged, not captured: a
      // single transient recipient failure must not page anyone.
      console.warn('[notifications-worker-client] dispatch failed for some recipients; retrying', {
        kind: body.kind,
        dispatchId,
        failedRecipients: failedCount,
        totalRecipients,
        failureReasons,
        attempt: attempt + 1,
      });
      await sleep(retryDelay);
    }
  } catch (error) {
    captureException(error, {
      tags,
      extra: { kind: body.kind, dispatchId },
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

export async function dispatchAgentBriefingPush(
  input: Omit<InternalDispatchAgentBriefingRequest, 'kind'>
): Promise<boolean> {
  return dispatchInternal({ kind: 'agent_briefing', ...input });
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
 * Dispatches an account-security notice push. Never rejects; returns whether
 * the worker accepted it, so the caller can report a refused push alongside
 * the email it sends for the same event.
 */
export async function dispatchAccountSecurityPush(
  input: Omit<InternalDispatchAccountSecurityRequest, 'kind'>
): Promise<boolean> {
  return dispatchInternal({ kind: 'account_security', ...input });
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
  const endpoint = await resolveInternalWorkerEndpoint(GLANCEABLE_REFRESH_ENDPOINT);
  if (!endpoint) {
    return;
  }

  const tags = {
    source: 'notifications-worker-client',
    endpoint: GLANCEABLE_REFRESH_ENDPOINT.tag,
  };
  try {
    // The registration mutation awaits this. The worker's refresh is one
    // snapshot fetch plus parallel APNs sends, so 10s is generous; past it
    // the retired row is still superseded and the next refresh ends the card,
    // and the shorter bound keeps a hung worker from holding the caller's
    // token-mutation queue.
    const result = await postInternal(endpoint, input, { timeoutMs: 10_000 });
    if (!result.ok) {
      captureException(result.error, {
        tags,
        extra: { status: result.status },
      });
    }
  } catch (error) {
    captureException(error, {
      tags,
    });
  }
}
