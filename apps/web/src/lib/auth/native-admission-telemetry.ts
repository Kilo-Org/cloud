import 'server-only';
import { captureMessage } from '@sentry/nextjs';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  isMobileDimensions,
  readClientDimensions,
  type ClientDimensions,
} from '@kilocode/web-shared/lib/observability/request-timing';
import type {
  AdmissionKind,
  AdmissionMissingReason,
  AdmissionPlatform,
  AdmissionRefusalDetail,
  AdmissionRefusalReason,
} from './native-admission';
import type { PlayIntegrityDiagnostics } from './native-admission-google';

// ── Expected-condition telemetry ───────────────────────────────────────────

/**
 * Interval-aggregated counter for expected, traffic-scaled admission
 * conditions (legacy clients, malformed shapes). Emits one structured log
 * line per 60 s window carrying the count observed in that window instead of
 * one event per request, so rollout traffic cannot flood telemetry. The
 * window start is carried on each line so a burst after a traffic pause is
 * attributed to the window it was counted in.
 */
const AGGREGATE_INTERVAL_MS = 60_000;
const admissionCounters = new Map<string, number>();
let admissionCountersWindowStart = 0;

function flushAdmissionCounters(now: number): void {
  if (admissionCounters.size === 0) return;
  for (const [metric, count] of admissionCounters) {
    warnExceptInTest(
      JSON.stringify({
        event: 'native_admission_aggregate',
        metric,
        count,
        intervalMs: AGGREGATE_INTERVAL_MS,
        // Window the counts were accumulated in, not the flush time.
        windowStart: new Date(admissionCountersWindowStart).toISOString(),
        at: new Date(now).toISOString(),
      })
    );
  }
  admissionCounters.clear();
}

/**
 * Roll the window forward when it has elapsed. Called on every admission
 * check, so the window closes on any later traffic rather than only when
 * another counted condition arrives — the last window of a sparse traffic
 * pattern is not silently dropped.
 */
export function rollAdmissionWindowIfNeeded(now: number): void {
  if (now - admissionCountersWindowStart >= AGGREGATE_INTERVAL_MS) {
    flushAdmissionCounters(now);
    admissionCountersWindowStart = now;
  }
}

/**
 * Count an expected, traffic-scaled admission outcome. Refusals are the normal
 * shape of hostile traffic, so they aggregate per window instead of emitting
 * one event each. Unexpected provider faults keep their per-event message.
 */
export function countAdmissionCondition(metric: string): void {
  const now = Date.now();
  rollAdmissionWindowIfNeeded(now);
  admissionCounters.set(metric, (admissionCounters.get(metric) ?? 0) + 1);
}

/**
 * The aggregate window is closed only by later native-auth traffic on the same
 * instance, so a rare refusal counted by an instance that serves nothing
 * further would otherwise leave no trace. One report per class per interval
 * keeps such a refusal visible while bounding the volume a repeated one can
 * produce.
 */
const RARE_REFUSAL_REPORT_INTERVAL_MS = 60_000;
const lastRareRefusalReportAt = new Map<string, number>();

/** Emits at most one per-event report per class per interval per instance. */
export function reportAdmissionRefusalOnce(metric: string): void {
  const now = Date.now();
  if (now - (lastRareRefusalReportAt.get(metric) ?? 0) < RARE_REFUSAL_REPORT_INTERVAL_MS) return;
  lastRareRefusalReportAt.set(metric, now);
  captureMessage(metric);
}

/** Exported for tests: flush any pending counters and reset the interval. */
export function resetAdmissionCountersForTests(): void {
  admissionCounters.clear();
  admissionCountersWindowStart = 0;
  lastRareRefusalReportAt.clear();
}

// ── Per-request outcome record ─────────────────────────────────────────────

/**
 * One structured record per mobile request to the native sign-in token route.
 *
 * The record answers where a sign-in attempt stopped without carrying anything
 * the client sent. Every value is either a bounded header dimension from
 * `readClientDimensions` or a fixed value this code names itself: no token, id,
 * address, user agent, key id, digest, nonce, error message, or response body.
 *
 * Two different notions of platform and version are kept apart on purpose:
 * `headerPlatform`/`headerVersion` are the marketing headers the app sends, so
 * they identify a cohort but not a build, install track, or device; a proof can
 * only be called verified iOS or Android through `proofPlatform`, the shape the
 * verified admission payload declared. Neither is certified build identity.
 *
 * Admission and outcome are separate axes. `admission` says whether the gate
 * admitted the request and why not; `outcome` says how the request ended, so a
 * refusal after an accepted proof is never counted as an admission refusal.
 *
 * Emission is gated on the allowlisted mobile client header, so web and
 * extension traffic costs one header read and write nothing.
 */

const ROUTE = '/api/auth/native/token';

/**
 * Where the request ended. `admission_refused` and `admission_provider_fault`
 * describe the admission gate itself; `refused_after_admission` and
 * `failed_after_admission` mean the proof was accepted and a later stage
 * (identity, eligibility, settlement, rate limit, or session issuance) decided
 * the request.
 */
export type NativeTokenOutcome =
  | 'token_issued'
  | 'request_rejected'
  | 'rate_limited_before_admission'
  | 'admission_refused'
  | 'admission_provider_fault'
  | 'refused_after_admission'
  | 'failed_after_admission'
  /** Threw with no admission stage recorded, so it cannot be attributed. */
  | 'failed'
  /** Returned 200 with no admission stage recorded. A wiring regression. */
  | 'incomplete';

/**
 * The admission branch the request took. `missing` and `malformed` split one
 * refusal into its two shapes: `missing` means the body carried no `admission`
 * field at all, `malformed` means the field was supplied and failed the shape
 * rule named by `reason`.
 */
export type NativeAdmissionBranch =
  | 'not_attempted'
  | 'missing'
  | 'malformed'
  | 'refused'
  | 'provider_fault'
  | 'passed';

export type NativeAdmissionRecord = {
  type: 'native_admission';
  route: typeof ROUTE;
  /** Bounded `x-kilo-app-platform` header value, or `'other'`/null. */
  headerPlatform: string | null;
  /** Bounded marketing app version header. Not a build identifier. */
  headerVersion: string | null;
  admission: NativeAdmissionBranch;
  /**
   * The fixed rule that refused this request, for a `missing`, `malformed`,
   * `refused`, or `not_attempted` branch. A body/transport reason and an
   * admission-shape reason live in one closed union so a reader needs no
   * lookup outside this type.
   */
  reason?: AdmissionMissingReason | AdmissionRefusalReason | RequestRejectionReason;
  /** The platform a verified admission payload declared, once it parsed. */
  proofPlatform?: AdmissionPlatform;
  /** Which verifier answered, for a verified refusal. */
  admissionSource?: AdmissionRefusalDetail['source'];
  /** Proof shape named by the admission payload, for a verified refusal. */
  proofKind?: AdmissionKind;
  outcome: NativeTokenOutcome;
  /** Play Integrity classification; only on an Android refusal. */
  android?: PlayIntegrityDiagnostics;
};

/**
 * Why a request ended before the admission gate. `invalid_json` is a body that
 * did not parse; `invalid_request` is a body that parsed but did not match the
 * request schema; `address_rate_limited` is the client-address firewall rule.
 */
export type RequestRejectionReason = 'invalid_json' | 'invalid_request' | 'address_rate_limited';

type AdmissionState =
  | { state: 'none' }
  | { state: 'not_attempted'; reason: RequestRejectionReason }
  | { state: 'missing'; reason: AdmissionMissingReason }
  | { state: 'refused'; detail: AdmissionRefusalDetail }
  | { state: 'provider_fault' }
  | { state: 'passed'; proofPlatform: AdmissionPlatform };

/**
 * Per-request collector. Every method is a no-op for a request outside the
 * mobile cohort, so a call site does not need to know whether it is recorded.
 */
export type NativeTokenTelemetry = {
  /** The body was not JSON, or did not match the request schema. */
  requestRejected(
    reason: Extract<RequestRejectionReason, 'invalid_json' | 'invalid_request'>
  ): void;
  /** The client-address firewall rule refused before the admission gate. */
  addressRateLimited(): void;
  /** The admission gate refused a missing or malformed proof. */
  admissionMissing(reason: AdmissionMissingReason): void;
  /** A verifier refused the parsed proof. */
  admissionRefused(detail: AdmissionRefusalDetail): void;
  /** The admission verifier threw, so the request is a retryable fault. */
  admissionProviderFault(): void;
  /** The proof verified. `proofPlatform` is the shape it declared. */
  admissionPassed(proofPlatform: AdmissionPlatform): void;
  /** Write the single record for this request. Second calls do nothing. */
  emit(status: number): void;
};

const NOOP_TELEMETRY: NativeTokenTelemetry = {
  requestRejected: () => {},
  addressRateLimited: () => {},
  admissionMissing: () => {},
  admissionRefused: () => {},
  admissionProviderFault: () => {},
  admissionPassed: () => {},
  emit: () => {},
};

function admissionBranch(state: AdmissionState): NativeAdmissionBranch {
  switch (state.state) {
    case 'none':
    case 'not_attempted':
      return 'not_attempted';
    case 'missing':
      // The gate's own `absent` value means the field was never supplied; every
      // other reason means it was supplied and failed a shape rule.
      return state.reason === 'absent' ? 'missing' : 'malformed';
    case 'refused':
      return 'refused';
    case 'provider_fault':
      return 'provider_fault';
    case 'passed':
      return 'passed';
  }
}

function classifyOutcome(state: AdmissionState, status: number): NativeTokenOutcome {
  switch (state.state) {
    case 'missing':
    case 'refused':
      return 'admission_refused';
    case 'provider_fault':
      return 'admission_provider_fault';
    case 'not_attempted':
      return state.reason === 'address_rate_limited'
        ? 'rate_limited_before_admission'
        : 'request_rejected';
    case 'passed':
      if (status === 200) return 'token_issued';
      if (status >= 500) return 'failed_after_admission';
      return 'refused_after_admission';
    case 'none':
      // No stage was recorded, so the request ended before the admission gate
      // (a throw while parsing) or a call site forgot to record. Only a 5xx is
      // safe to call a failure; anything else is a wiring regression this
      // record must surface rather than mislabel.
      return status >= 500 ? 'failed' : 'incomplete';
  }
}

function buildRecord(
  dimensions: ClientDimensions,
  state: AdmissionState,
  status: number
): NativeAdmissionRecord {
  const record: NativeAdmissionRecord = {
    type: 'native_admission',
    route: ROUTE,
    headerPlatform: dimensions.platform,
    headerVersion: dimensions.version,
    admission: admissionBranch(state),
    outcome: classifyOutcome(state, status),
  };

  if (state.state === 'passed') {
    record.proofPlatform = state.proofPlatform;
  } else if (state.state === 'missing' || state.state === 'not_attempted') {
    record.reason = state.reason;
  } else if (state.state === 'refused') {
    record.reason = state.detail.reason;
    record.proofPlatform = state.detail.proofPlatform;
    record.admissionSource = state.detail.source;
    if (state.detail.proofKind !== undefined) record.proofKind = state.detail.proofKind;
    if (state.detail.android !== undefined) record.android = state.detail.android;
  }

  return record;
}

/**
 * Persist one record. A telemetry line must never fail the request, so both
 * building and serializing it are inside the guard, matching the timing line's
 * contract.
 */
function writeRecord(build: () => NativeAdmissionRecord): void {
  try {
    console.log(JSON.stringify(build()));
  } catch {
    // Nothing to do: the request outcome does not depend on the log line.
  }
}

export function startNativeTokenTelemetry(request: Request): NativeTokenTelemetry {
  let dimensions: ClientDimensions;
  try {
    dimensions = readClientDimensions(request.headers);
  } catch {
    return NOOP_TELEMETRY;
  }
  // The cohort gate is the same test the timing line uses, applied to the
  // already-validated client dimension, so the two surfaces cannot disagree.
  if (!isMobileDimensions(dimensions.client)) return NOOP_TELEMETRY;

  const bound = dimensions;
  let state: AdmissionState = { state: 'none' };
  let emitted = false;

  return {
    requestRejected(reason) {
      state = { state: 'not_attempted', reason };
    },
    addressRateLimited() {
      state = { state: 'not_attempted', reason: 'address_rate_limited' };
    },
    admissionMissing(reason) {
      state = { state: 'missing', reason };
    },
    admissionRefused(detail) {
      state = { state: 'refused', detail };
    },
    admissionProviderFault() {
      state = { state: 'provider_fault' };
    },
    admissionPassed(proofPlatform) {
      state = { state: 'passed', proofPlatform };
    },
    emit(status) {
      if (emitted) return;
      emitted = true;
      writeRecord(() => buildRecord(bound, state, status));
    },
  };
}
