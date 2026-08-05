/**
 * Best-effort server capture for cataloged accepted-phase analytics events.
 *
 * Catalog contract (P1-A-07a / DEC-05): terminal outcome events (`*_settled`)
 * deliver only through the durable outbox via the ledger settle path (Wave 2,
 * `packages/db/src/operation-ledger.ts`) — this helper excludes them at the
 * type level via `AcceptedPhaseEventName` and never touches the
 * `analytics_event_outbox` table. Accepted-phase events are best-effort:
 * scheduled after the response is sent (`runAfterResponse`), awaited, bounded
 * by `CAPTURE_TIMEOUT_MS`, never thrown to the caller, and Sentry-reported on
 * failure. Capture is fire-and-forget by design; callers do not await it.
 *
 * `distinctId` is the identity channel, matching the cross-platform
 * convention (mobile `identifyUser(email)` and the web provider identify by
 * email). It is not an event property, so the DEC-05 property deny-list does
 * not apply to it.
 */
import 'server-only';

import { captureException } from '@sentry/nextjs';
import { after } from 'next/server';

import type { AcceptedPhaseEventName, AnalyticsEventMap } from '@kilocode/app-shared/analytics';

import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';
import PostHogClient from '@/lib/posthog';

/** Upper bound for a single accepted-phase capture attempt. */
export const CAPTURE_TIMEOUT_MS = 2000;

export type CaptureCatalogEventParams<K extends AcceptedPhaseEventName> = {
  /** Identity channel, not an event property (the user's email). */
  distinctId: string;
  event: K;
  properties: AnalyticsEventMap[K];
};

/**
 * Runs `work` after the response has been sent so serverless functions stay
 * alive for the capture. In automated tests the work runs inline so jest can
 * assert on it. Best-effort: a synchronous `after()` failure (called outside a
 * request scope) or a rejection from the scheduled work promise is
 * Sentry-reported here and never propagates to the caller or becomes an
 * unhandled rejection.
 */
export async function runAfterResponse(work: () => Promise<void>): Promise<void> {
  if (IS_IN_AUTOMATED_TEST) {
    await work();
    return;
  }
  try {
    // The scheduled promise must never reject unhandled; `work` already
    // reports its own capture failures, this catch is the safety net.
    after(() => {
      void work().catch(reportCaptureError);
    });
  } catch (error) {
    reportCaptureError(error);
  }
}

/** Best-effort failure reporting for the post-response scheduling path. */
function reportCaptureError(error: unknown): void {
  captureException(error, {
    tags: { source: 'analytics_capture_catalog_event' },
  });
}

/**
 * Captures a cataloged accepted-phase event. `event` is restricted to
 * accepted-phase names; terminal outcome events cannot be passed here (they
 * must go through the ledger settle path). Best-effort: a failure is
 * Sentry-reported and never reaches the caller.
 */
export function captureCatalogEvent<K extends AcceptedPhaseEventName>(
  params: CaptureCatalogEventParams<K>
): void {
  void runAfterResponse(() => captureAcceptedEvent(params));
}

async function captureAcceptedEvent<K extends AcceptedPhaseEventName>(
  params: CaptureCatalogEventParams<K>
): Promise<void> {
  try {
    await bounded(
      Promise.resolve().then(() => sendToPostHog(params)),
      CAPTURE_TIMEOUT_MS
    );
  } catch (error) {
    captureException(error, {
      tags: { source: 'analytics_capture_catalog_event' },
      extra: { event: params.event },
    });
  }
}

function sendToPostHog<K extends AcceptedPhaseEventName>(
  params: CaptureCatalogEventParams<K>
): void {
  PostHogClient().capture({
    distinctId: params.distinctId,
    event: params.event,
    properties: params.properties,
  });
}

/**
 * Resolves when `promise` settles or after `ms`, whichever comes first. A
 * timeout releases the awaiting work without cancelling the inner promise; its
 * eventual rejection is already handled by the attached callbacks.
 */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
