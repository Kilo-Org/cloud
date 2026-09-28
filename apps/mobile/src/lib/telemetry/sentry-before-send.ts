/**
 * Pure composition for Sentry's `beforeSend` gate.
 *
 * Two responsibilities, in this order:
 * 1. Drop harness-injected E2E faults (see lib/telemetry/e2e-fault). A fault the
 *    E2E harness opened deliberately is not a product defect, so no Sentry
 *    issue may be filed for it — the tag is what makes it separable and the
 *    drop keeps it out of the issue stream entirely.
 * 2. Scrub the surviving event (token redaction, query-string stripping).
 *
 * Kept SDK-free and total so it is unit-testable under node vitest, where the
 * React Native Sentry SDK does not parse.
 */

import { isE2eInjectedFault } from '@/lib/telemetry/e2e-fault';
import { scrubEvent } from '@/lib/telemetry/sentry-scrub';

/** The part of Sentry's capture hint this gate reads. */
export type BeforeSendHint = { originalException?: unknown };

/**
 * Returns `null` to drop the event (a harness fault), otherwise the scrubbed
 * event. Never throws: a malformed hint keeps the event rather than dropping a
 * real crash.
 */
export function beforeSendScrubbedEvent<T>(event: T, hint?: BeforeSendHint): T | null {
  try {
    if (isE2eInjectedFault(hint?.originalException)) {
      return null;
    }
  } catch {
    // Fall through to scrubbing; a gate failure must not drop a real crash.
  }
  return scrubEvent(event);
}
