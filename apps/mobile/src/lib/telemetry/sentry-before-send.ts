/**
 * Pure composition for Sentry's `beforeSend` gate.
 *
 * Three responsibilities, in this order:
 * 1. Drop harness-injected E2E faults (see lib/telemetry/e2e-fault). A fault the
 *    E2E harness opened deliberately is not a product defect, so no Sentry
 *    issue may be filed for it — the tag is what makes it separable and the
 *    drop keeps it out of the issue stream entirely. A keychain call skipped
 *    on a locked device (`ProtectedDataUnavailableError`) is dropped too: the
 *    lock is expected, not a defect.
 * 2. Project an App Attest diagnostic to its allowlisted fields (see
 *    lib/telemetry/app-attest-events). That event reports a native proof
 *    failure and must not inherit scope identity, breadcrumbs or contexts.
 * 3. Scrub every other event (token redaction, query-string stripping).
 *
 * Kept SDK-free and total so it is unit-testable under node vitest, where the
 * React Native Sentry SDK does not parse.
 */

import * as z from 'zod';

import { ProtectedDataUnavailableError } from '@/lib/protected-data';
import {
  isAppAttestFailureEvent,
  projectAppAttestFailureEvent,
} from '@/lib/telemetry/app-attest-events';
import { isE2eInjectedFault } from '@/lib/telemetry/e2e-fault';
import { scrubBreadcrumb, scrubEvent } from '@/lib/telemetry/sentry-scrub';

// Native request breadcrumbs keep the query and the fragment in their own data
// fields, which the breadcrumb scrub does not read.
const NATIVE_URL_PART_FIELDS = new Set(['http.query', 'http.fragment']);
const fieldsSchema = z.record(z.string(), z.unknown());
const breadcrumbsSchema = z.array(fieldsSchema);

function withoutNativeUrlParts(breadcrumb: Record<string, unknown>) {
  const data = fieldsSchema.safeParse(breadcrumb.data);
  if (!data.success) {
    return breadcrumb;
  }
  const kept = Object.entries(data.data).filter(([key]) => !NATIVE_URL_PART_FIELDS.has(key));
  return { ...breadcrumb, data: Object.fromEntries(kept) };
}

// A breadcrumb that cannot be read or scrubbed is dropped rather than sent
// unscrubbed.
function scrubOneBreadcrumb(breadcrumb: Record<string, unknown>) {
  try {
    const scrubbed = scrubBreadcrumb(withoutNativeUrlParts(breadcrumb));
    return scrubbed === null ? [] : [scrubbed];
  } catch {
    return [];
  }
}

// The SDK merges the native SDK's breadcrumbs into the event before beforeSend,
// and they never pass beforeBreadcrumb. A list this module cannot read is
// dropped rather than sent unscrubbed.
function scrubMergedBreadcrumbs(event: unknown): void {
  // SAFETY: The SDK supplies the event object. Only `breadcrumbs` is read and replaced.
  const fields = event as Record<string, unknown>;
  if (fields.breadcrumbs === undefined) {
    return;
  }
  const breadcrumbs = breadcrumbsSchema.safeParse(fields.breadcrumbs);
  fields.breadcrumbs = breadcrumbs.success ? breadcrumbs.data.flatMap(scrubOneBreadcrumb) : [];
}

/** The part of Sentry's capture hint this gate reads. */
export type BeforeSendHint = { originalException?: unknown };

/**
 * Returns `null` to drop the event (a harness fault, a locked-device skip, or
 * a malformed App Attest diagnostic). An App Attest event is projected to its
 * allowlisted fields before it leaves; everything else is scrubbed. Never
 * throws: a malformed hint keeps the event rather than dropping a real crash,
 * and a scrub that throws drops the event rather than sending it unscrubbed.
 */
export function beforeSendScrubbedEvent<T>(event: T, hint?: BeforeSendHint): T | null {
  try {
    const original = hint?.originalException;
    if (isE2eInjectedFault(original) || original instanceof ProtectedDataUnavailableError) {
      return null;
    }
  } catch {
    // Fall through to scrubbing; a gate failure must not drop a real crash.
  }
  try {
    if (isAppAttestFailureEvent(event)) {
      return projectAppAttestFailureEvent(event);
    }
    scrubMergedBreadcrumbs(event);
    return scrubEvent(event);
  } catch {
    return null;
  }
}
