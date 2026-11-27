import 'server-only';

import {
  BENCHMARK_ASSIGNMENT_HEADER,
  BENCHMARK_CASE_ADMIT_PATH,
  BENCHMARK_CASE_INFERENCE_GATEWAY_PATH,
  BENCHMARK_GATEWAY_ASSIGNMENT_SCOPE,
  BenchmarkCaseAdmitResponseSchema,
  BenchmarkGatewayAssignmentSchema,
  benchmarkGatewayAssignmentParts,
  isBenchmarkProjectId,
  isVirtualAutoModelId,
  type BenchmarkAdmissionRefusalReason,
  type BenchmarkGatewayAssignment,
  type BenchmarkInferenceApi,
} from '@kilocode/auto-routing-contracts';
import { base64urlToBytes } from '@kilocode/worker-utils/base64url';
import { verifyCallbackToken } from '@kilocode/worker-utils/callback-token';
import { AUTO_ROUTING_BENCHMARK_WORKER_URL } from '@kilocode/web-shared/lib/config.server';
import { parseInternalServiceUrl } from '@kilocode/web-shared/lib/internal-service-url';

/** The assignment token lives no longer than one case attempt; the Worker mints it. */
export const BENCHMARK_ASSIGNMENT_TTL_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 5_000;
const MAX_ENCODED_ASSIGNMENT_LENGTH = 4096;
const ADMIT_TIMEOUT_MS = 10_000;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export type BenchmarkAssignmentVerification =
  | { ok: true; assignment: BenchmarkGatewayAssignment }
  | { ok: false; response: Response };

export type BenchmarkRefusal = {
  reason: BenchmarkAdmissionRefusalReason;
  retryable: boolean;
};

import { NextResponse } from 'next/server';

export function benchmarkRefusalResponse(
  reason: BenchmarkAdmissionRefusalReason,
  retryable: boolean
): NextResponse {
  const status =
    // A bad envelope is a credential error, not a payment one: 401 so the Worker cannot read it
    // as an account that failed to pay.
    reason === 'assignment_invalid'
      ? 401
      : reason === 'payment_refused' ||
          reason === 'payer_unavailable' ||
          reason === 'no_funded_payer'
        ? 402
        : reason === 'admission_unavailable'
          ? 503
          : 409;
  return NextResponse.json(
    {
      error: {
        // Only an account that failed to fund this call is a payer refusal; a bad credential is
        // reported as itself so a Worker cannot detach a payer for a problem with its envelope.
        code:
          reason === 'assignment_invalid'
            ? 'benchmark_assignment_invalid'
            : 'benchmark_payer_refused',
        reason,
        retryable,
      },
    },
    {
      status,
      headers: {
        // Proven: no provider call was made for this reason.
        'x-kilo-benchmark-admission': 'refused',
      },
    }
  );
}

/**
 * Verify the signed assignment the Worker attached. Purpose-separated HMAC over every field
 * (so the payer and the usage id are bound to this one call), bounded TTL and encoding.
 * Nothing here reads a caller header other than the two the Worker sets.
 */
export async function verifyBenchmarkAssignment(
  headers: Headers,
  secret: string | undefined,
  now = Date.now()
): Promise<BenchmarkAssignmentVerification> {
  // An unverifiable envelope proves nothing about the payer: nothing was dispatched, so the
  // account is never detached or charged for it.
  const invalid = (): BenchmarkAssignmentVerification => ({
    ok: false,
    response: benchmarkRefusalResponse('assignment_invalid', false),
  });
  const encoded = headers.get(BENCHMARK_ASSIGNMENT_HEADER);
  const authorization = headers.get('authorization');
  if (
    !secret ||
    !encoded ||
    encoded.length > MAX_ENCODED_ASSIGNMENT_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !authorization?.startsWith('Bearer ')
  )
    return invalid();

  let decoded: unknown;
  try {
    decoded = JSON.parse(utf8.decode(base64urlToBytes(encoded)));
  } catch {
    return invalid();
  }
  const parsed = BenchmarkGatewayAssignmentSchema.safeParse(decoded);
  if (!parsed.success) return invalid();
  const assignment = parsed.data;
  if (
    assignment.startedAt > now + CLOCK_SKEW_MS ||
    now - assignment.startedAt >= BENCHMARK_ASSIGNMENT_TTL_MS
  )
    return invalid();
  const authenticated = await verifyCallbackToken({
    secret,
    token: authorization.slice('Bearer '.length),
    scope: BENCHMARK_GATEWAY_ASSIGNMENT_SCOPE,
    resourceParts: benchmarkGatewayAssignmentParts(assignment),
    observation: { receiver: 'ai-gateway' },
  });
  return authenticated ? { ok: true, assignment } : invalid();
}

/**
 * The last trusted check before the provider call. The Worker re-reads the case fence, the
 * current payer selection and the platform latch; the gateway never overrides the payer it
 * signed, so a `payer_changed` here means "select again", not "bill someone else".
 *
 * An unreachable callback is `admission_unavailable`: nothing was sent upstream, but the
 * Worker's admit may have committed, so the request must be fenced rather than replayed.
 */
export async function requestBenchmarkAdmission(
  assignment: BenchmarkGatewayAssignment,
  options: { secret: string; fetchImpl?: typeof fetch; workerUrl?: string } = {
    secret: '',
  }
): Promise<BenchmarkRefusal | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const workerUrl = (options.workerUrl ?? AUTO_ROUTING_BENCHMARK_WORKER_URL).replace(/\/+$/, '');
  const body = JSON.stringify({
    phase: 'admit',
    assignment,
    usageId: assignment.usageId,
  });
  // The Worker admits on the constant-time Bearer check only, so an absent secret cannot be
  // admitted. Refuse before sending rather than let an unauthenticated call reach it.
  if (!options.secret) return { reason: 'admission_unavailable', retryable: true };
  // An unset or refused Worker URL ('' outside production) is unavailable the same way, so no
  // relative or production callback is attempted.
  if (!parseInternalServiceUrl(workerUrl)) {
    return { reason: 'admission_unavailable', retryable: true };
  }
  let response: Response;
  try {
    response = await fetchImpl(`${workerUrl}${BENCHMARK_CASE_ADMIT_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The Worker's admit route authenticates this callback with its constant-time Bearer
        // check; the secret stays on this internal hop and never reaches a runner or a public
        // route.
        authorization: `Bearer ${options.secret}`,
      },
      body,
      signal: AbortSignal.timeout(ADMIT_TIMEOUT_MS),
    });
  } catch {
    return { reason: 'admission_unavailable', retryable: true };
  }
  const parsed = BenchmarkCaseAdmitResponseSchema.safeParse(
    await response.json().catch(() => null)
  );
  if (!parsed.success) return { reason: 'admission_unavailable', retryable: true };
  if (parsed.data.decision === 'admit') return null;
  return { reason: parsed.data.reason, retryable: parsed.data.retryable };
}

/**
 * The model a case request may ask for: the exact signed concrete model, never a routed
 * alias and never a virtual auto model. A different model means the caller is trying to make
 * the payer fund something the case did not sign.
 */
export function signedModelViolation(
  assignment: BenchmarkGatewayAssignment,
  requestedModel: string
): boolean {
  return (
    requestedModel !== assignment.model ||
    isVirtualAutoModelId(requestedModel) ||
    requestedModel.startsWith('~')
  );
}

export function benchmarkGatewayPathExists(headers: Headers): boolean {
  // Kept for the route facade tests: the internal route is the only producer of this path.
  return headers.get('x-kilo-internal-benchmark-route') === BENCHMARK_CASE_INFERENCE_GATEWAY_PATH;
}

/** The inference API the signed assignment names, independent of the inbound URL. */
export function assertApiShape(
  assignment: BenchmarkGatewayAssignment,
  body: Record<string, unknown>
): boolean {
  const stream = body.stream;
  if (stream !== undefined && typeof stream !== 'boolean') return false;
  if (assignment.api === 'messages') return Array.isArray(body.messages);
  if (assignment.api === 'chat/completions') return Array.isArray(body.messages);
  const input: unknown = body.input;
  return input === undefined || typeof input === 'string' || Array.isArray(input);
}

/** The project id a benchmark case request must carry: the signed one, and nothing else. */
export function projectHeaderMatchesAssignment(
  assignment: BenchmarkGatewayAssignment,
  headerValue: string | null
): boolean {
  if (headerValue === null) return true;
  return isBenchmarkProjectId(headerValue) && headerValue === assignment.projectId;
}

export type { BenchmarkInferenceApi };
