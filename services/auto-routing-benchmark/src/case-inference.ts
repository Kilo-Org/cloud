/**
 * Case-scoped inference proxy for paid runs.
 *
 * The runner container holds no credential: its CLI points at a local reverse proxy that
 * forwards only the three inference APIs here, with a case capability (a short-lived HMAC
 * over the exact `(engineIdentity, runId, model, variant, caseId, repetition, generation,
 * startedAt)` tuple) plus the signed invocation header. This route authenticates that tuple,
 * refuses anything that is not the live generation it names, then asks the case store to
 * select the payer for one model request and signs the gateway's assignment envelope.
 *
 * Two different cancellation facts must not be confused:
 * - A paused runner stops at once: no new upstream call is started for it, and a request
 *   whose caller already disconnected before admission is refused here.
 * - A call that was already dispatched keeps its payer and its upstream stream. The native
 *   usage writer must still record what the provider yielded, so the runner's abort signal is
 *   deliberately not forwarded after dispatch; dropping the upstream would lose billed usage.
 *
 * After admission, every gateway status (including a provider 402/403) is terminal and keeps
 * the payer. Only a trusted pre-upstream refusal may rotate to another candidate, and only
 * via the store's `refuse` transition (never a permanent account detach).
 */
import {
  BENCHMARK_ASSIGNMENT_HEADER,
  BENCHMARK_CASE_ADMIT_PATH,
  BENCHMARK_MODEL_REQUEST_ID_HEADER,
  BENCHMARK_PLATFORM_PROJECT_ID,
  BENCHMARK_CASE_INFERENCE_PATH,
  BENCHMARK_GATEWAY_ASSIGNMENT_SCOPE,
  BenchmarkCaseAdmitRequestSchema,
  BenchmarkInferenceApiSchema,
  benchmarkGatewayAssignmentParts,
  isVirtualAutoModelId,
  type BenchmarkCaseInvocation,
  type BenchmarkGatewayAssignment,
  type BenchmarkInferenceApi,
} from '@kilocode/auto-routing-contracts';
import { bytesToBase64url } from '@kilocode/worker-utils/base64url';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';
import { createUsageId } from '@kilocode/worker-utils/usage-id';
import type { Context, Hono } from 'hono';
import * as z from 'zod';
import type { HonoEnv } from './hono-env';
import { BENCHMARK_CASE_HEADER, verifyCaseInferenceCapability } from './case-inference-capability';
import {
  admitPaidModelRequestStatements,
  readPaidCaseRun,
  paidModelRequestAdmission,
  readPaidModelRequest,
  refusePaidModelRequestStatements,
  selectPaidModelRequestPayerStatements,
  type PaidCaseKey,
  type PaidModelRequestRow,
} from './paid-case-store';
import { PaidBenchmarkPlanSchema } from './paid-benchmark-plan';
import { reconcilePaidPayerReceipts } from './paid-benchmark';

/** A disconnected runner's drain stops here; the writer has already seen the real usage. */
const ADMITTED_DRAIN_MAX_BYTES = 32 * 1024 * 1024;

/** An internal bearer longer than this is not a secret anyone provisioned. */
const MAX_INTERNAL_BEARER_LENGTH = 512;

/** Request bodies are JSON; a larger body is not a benchmark case prompt. */
export const CASE_INFERENCE_BODY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Marks a reply this route originated as a terminal stop for the case. The runner's proxy
 * trusts it only when the reply is not an admitted upstream one, so a provider that echoes
 * the header can never pause a case. The reason travels here, never in body text: the runner
 * does not parse provider or error bodies for this.
 */
export const BENCHMARK_CASE_STOP_HEADER = 'x-kilo-benchmark-stop';

/**
 * The narrow stop union the runner records, mirrored by `cli-runner.ts` (the runner side)
 * and asserted equal in this file's test so the wire cannot drift. `no_payer` is the only
 * money verdict, so a balance refusal is always distinguishable from a pause, a cancel, a
 * dead generation, an infrastructure outage and a permanent model failure.
 */
export const BENCHMARK_CASE_STOP_REASONS = [
  'paused',
  'no_payer',
  'cancelled',
  'not_live',
  // The Worker could not run its own billing/admission infrastructure before any provider
  // call: nothing was spent, so the case is neither graded nor paused nor counted as a
  // model attempt. The lane retries through normal backoff under the usual admission fence.
  'infra_unavailable',
  // The exact model is already terminally failed. Terminal for the pair, without a new
  // attempt or another permanent-failure vote.
  'model_permanently_failed',
] as const;
export type BenchmarkCaseStopReason = (typeof BENCHMARK_CASE_STOP_REASONS)[number];

/**
 * The gateway's single benchmark inference route. `api` travels in the request envelope so
 * one route serves all three native shapes.
 */
export const CASE_INFERENCE_GATEWAY_PATH = '/api/gateway/v1/internal/benchmark/case-inference';
/** Admission facts the gateway always returns. */
const ADMISSION_HEADERS = [
  'x-kilo-benchmark-admission',
  'x-kilo-benchmark-usage-id',
  'x-kilo-benchmark-model-request-id',
] as const;

/**
 * A refusal that provably made no provider call, so another candidate may be tried. Every
 * other refusal (case paused, duplicate, admission unavailable, unknown) either may already
 * have committed work or must not move: those fence the attempt instead of rotating.
 */
const ROTATABLE_REFUSALS: Record<string, true> = {
  payment_refused: true,
  payer_unavailable: true,
  payer_changed: true,
  attempt_superseded: true,
  // Kilo latched coverage while this user selection was in flight: the same model request is
  // reselected as a platform call, so no user provider call ever happens.
  platform_joined: true,
};

/**
 * Refusals that prove the selected account cannot pay. Only these detach it for the
 * generation; a superseded or platform-joined selection is retired without marking the
 * account bad, so it stays eligible for its other cases.
 */
const DETACHING_REFUSALS: Record<string, true> = {
  payment_refused: true,
  payer_unavailable: true,
};

/**
 * Refusals that mean "the outcome is not known yet", not "this payer cannot pay". A delayed
 * or missing native receipt, a busy admission path, or a still-open previous attempt must
 * never be read as no funds: the case pauses (retryable) so the receipt can land, and the
 * original model request is never reassigned.
 */
const RECEIPT_UNCONFIRMED_REFUSALS: Record<string, true> = {
  receipt_unconfirmed: true,
  admission_busy: true,
};

/** A bounded budget for trying candidate payers before answering "retry admission". */
const PAYER_ATTEMPT_DEADLINE_MS = 15_000;

/**
 * How long one request may wait for its own earlier receipt to book before giving up and
 * keeping the money state pending. Deliberately well inside `PAYER_ATTEMPT_DEADLINE_MS`: this
 * covers ordinary back-to-back work, and anything longer is the caller's retry to make rather
 * than a request that hangs on a receipt which may never arrive.
 */
const PRIOR_RECEIPT_WAIT_MS = 4_000;

export type CaseInferenceFailure = {
  error: { code: string; message: string };
};

export type CaseInferencePayer = {
  ownerType: 'user' | 'organization';
  ownerId: string;
  modelRequestId: string;
  assignmentId: string;
  usageId: string;
  requestId: string | null;
  executorUserId: string;
  projectId: string;
  /** The organization a platform-covered call bills; null for any pool payer. */
  platformOrganizationId: string | null;
  /** Exactly the two identity headers the gateway accepts; nothing else is forwarded. */
  headers: Record<string, string>;
};

/** A selection that must not dispatch, with the reason the runner may act on. */
export type CaseInferencePayerRefusal = { refused: string };

/**
 * The pair's terminal registry state, or null when it may still be measured. A pair that the
 * benchmark itself diagnosed as permanently failed cannot be admitted by any payer, so the
 * case pauses instead of spending: no detach, no charge, and unaffected pairs keep running.
 */
export async function permanentFailureVetoes(
  db: D1Database,
  key: PaidCaseKey,
  scope: { router: string; repetitions: number }
): Promise<boolean> {
  return (await permanentFailureReason(db, key, scope)) !== null;
}

async function permanentFailureReason(
  db: D1Database,
  key: PaidCaseKey,
  scope: { router: string; repetitions: number }
): Promise<string | null> {
  // The veto is scoped to the exact authoritative row for this measurement: another router's
  // or another engine's verdict says nothing about this one, and a matching row at a
  // different repetition count is a different measurement. A neighbouring engine's failure
  // must never block a pair that is still permitted here.
  const row = await db
    .prepare(
      `SELECT status, failure_class, failure_reason FROM benchmark_profiles
      WHERE router = ? AND engine_identity = ? AND model = ? AND variant = ?
        AND repetitions = ? AND status = 'unavailable'
      LIMIT 1`
    )
    .bind(scope.router, key.engineIdentity, key.model, key.variant, scope.repetitions)
    .first<{ status: string; failure_class: string | null; failure_reason: string | null }>();
  return row ? (row.failure_reason ?? 'permanently_failed') : null;
}

function refused(reason: string): CaseInferencePayerRefusal {
  return { refused: reason };
}

/** The case store's selection for one model request. */
export type CaseInferencePayerResolver = (input: {
  invocation: BenchmarkCaseInvocation;
  api: BenchmarkInferenceApi;
  /** Minted once per model request; a rotation reuses it with a new assignment. */
  modelRequestId: string;
}) => Promise<CaseInferencePayer | CaseInferencePayerRefusal | null>;

export type CaseInferenceDeps = {
  /** The HMAC secret the case capability is derived from (shared with its issuer). */
  capabilitySecret: string | undefined;
  /** The web origin: its gateway rewrite turns `/api/gateway/v1/*` into the real gateway. */
  gatewayBaseUrl: string;
  resolvePayer?: CaseInferencePayerResolver;
  /**
   * Retire an attempt that provably made no provider call so another candidate may be
   * selected for the same `modelRequestId`. Returns false when the store cannot prove that,
   * which fences the attempt instead of rotating it.
   */
  refusePayer?: (input: {
    payer: CaseInferencePayer;
    invocation: BenchmarkCaseInvocation;
    reason: string;
  }) => Promise<boolean>;
  /** Keeps an independent upstream drain alive after the runner disconnected. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Book this payer's older native receipts before the gateway reads its balance, so a debit
   * that committed in PostgreSQL after an earlier read cannot leave a stale green balance.
   * Only `recorded` receipts book; a still-pending one is left pending (never cleared, never
   * written as `no_funds`). `options.signal` and `options.deadline` bound the native read too,
   * so a slow receipt read can never outlive the request that asked for it. Omitting it means
   * the caller has nothing to reconcile — the production wiring always supplies it.
   */
  reconcilePayer?: (
    payer: CaseInferencePayer,
    options?: { signal?: AbortSignal; deadline?: number }
  ) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

function failure(code: string, message: string): CaseInferenceFailure {
  return { error: { code, message } };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A refusal this route originated, carrying the trusted stop marker the runner records.
 *
 * Only a refusal may carry it: an admitted upstream reply never does, and the runner's proxy
 * ignores the header unless admission is absent or exactly `refused`. That is what keeps a
 * provider that echoes the header inside a streamed completion from pausing a case.
 */
function stopResponse(
  reason: BenchmarkCaseStopReason,
  body: CaseInferenceFailure,
  status: number
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      [BENCHMARK_CASE_STOP_HEADER]: reason,
    },
  });
}

function parseApi(value: string | undefined): BenchmarkInferenceApi | null {
  const parsed = BenchmarkInferenceApiSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The route shape `/case-inference/{chat/completions|responses|messages}`. */
export function caseInferenceApiFromPath(path: string): BenchmarkInferenceApi | null {
  const prefix = `${BENCHMARK_CASE_INFERENCE_PATH}/`;
  if (!path.startsWith(prefix)) return null;
  return parseApi(path.slice(prefix.length));
}

export function caseKeyFromInvocation(invocation: BenchmarkCaseInvocation): PaidCaseKey {
  return {
    engineIdentity: invocation.engineIdentity,
    model: invocation.model,
    variant: invocation.variant,
    rep: invocation.repetition,
    caseId: invocation.caseId,
  };
}

/** Only the exact running generation of this case may call the gateway. */
async function liveCaseRun(db: D1Database, invocation: BenchmarkCaseInvocation) {
  const run = await readPaidCaseRun(db, caseKeyFromInvocation(invocation));
  if (!run) return null;
  if (run.generation !== invocation.generation) return null;
  if (run.executor_run_id !== null && run.executor_run_id !== invocation.runId) return null;
  return run.status === 'running' ? run : null;
}

/**
 * Read the request body and require that it asks for the exact signed model. A different
 * model, or an `auto` alias that would let the router pick a model nobody paid for, is
 * refused before any upstream call.
 */
async function readRequestBody(
  request: Request,
  invocation: BenchmarkCaseInvocation
): Promise<{ ok: true; body: string } | { ok: false; response: CaseInferenceFailure }> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > CASE_INFERENCE_BODY_MAX_BYTES)
    return { ok: false, response: failure('body_too_large', 'Case request body is too large.') };
  const body = await request.text();
  if (body.length > CASE_INFERENCE_BODY_MAX_BYTES)
    return { ok: false, response: failure('body_too_large', 'Case request body is too large.') };
  if (body.length === 0)
    return { ok: false, response: failure('invalid_body', 'Case request body is empty.') };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, response: failure('invalid_body', 'Case request body is not JSON.') };
  }
  if (typeof parsed !== 'object' || parsed === null || !('model' in parsed))
    return { ok: false, response: failure('missing_model', 'Case request body has no model.') };
  const model = parsed.model;
  if (typeof model !== 'string' || model.length === 0)
    return { ok: false, response: failure('missing_model', 'Case request body has no model.') };
  if (isVirtualAutoModelId(model))
    return {
      ok: false,
      response: failure('auto_model_refused', 'A benchmark case cannot request a routed alias.'),
    };
  if (model !== invocation.model)
    return {
      ok: false,
      response: failure('model_mismatch', 'Case request model does not match the signed case.'),
    };
  return { ok: true, body };
}

/** The upstream headers: identity comes only from the signed assignment. */
export function caseUpstreamHeaders(
  incoming: Headers,
  payer: CaseInferencePayer
): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...payer.headers };
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase();
    // The capability, the invocation, cookies and any caller identity must never reach the
    // gateway; the assignment headers above are the only identity this attempt carries.
    if (
      lower === 'authorization' ||
      lower === BENCHMARK_CASE_HEADER ||
      lower === BENCHMARK_ASSIGNMENT_HEADER ||
      lower === BENCHMARK_MODEL_REQUEST_ID_HEADER ||
      lower === 'cookie' ||
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'content-type' ||
      lower.startsWith('x-kilo-') ||
      lower.startsWith('x-forwarded-')
    )
      return;
    headers[lower] = value;
  });
  return headers;
}

function refusalReason(response: Response, body: unknown): string | null {
  if (response.headers.get('x-kilo-benchmark-admission') !== 'refused') return null;
  if (typeof body !== 'object' || body === null || !('error' in body)) return 'unknown';
  const error = body.error;
  if (typeof error !== 'object' || error === null || !('reason' in error)) return 'unknown';
  const reason = error.reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : 'unknown';
}

/**
 * A streaming reply that stays complete for the native writer.
 *
 * Returning `upstream.body` directly is not enough: when the runner disconnects, cancelling
 * the returned body propagates back into the provider stream and truncates the text the usage
 * writer parses. This adapter forwards chunks as they arrive (no buffering) and, on
 * cancellation only, keeps reading the upstream stream to completion in the background so
 * `countAndStoreUsage` sees the whole body and commits the usage row. It never drains a
 * request the gateway refused (there is no usage to record) and never starts anything new.
 */
export function admittedReplyStream(
  upstreamBody: ReadableStream<Uint8Array>,
  waitUntil?: (promise: Promise<unknown>) => void
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  let draining = false;
  const drainToEnd = async () => {
    if (draining) return;
    draining = true;
    let drained = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        // Discard, but count: the drain is bounded so a runaway provider cannot keep a
        // waitUntil task alive forever once the runner is gone.
        drained += next.value.byteLength;
        if (drained > ADMITTED_DRAIN_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          return;
        }
      }
    } catch {
      // A provider that tears the stream still has whatever it already sent.
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      const task = drainToEnd();
      if (waitUntil) waitUntil(task);
      else void task;
    },
  });
}

/**
 * Forward one authenticated case request and stream the gateway reply straight back. The
 * caller's abort signal is intentionally not forwarded: after dispatch the provider may
 * already have yielded usage that the native writer must record.
 */
export async function forwardCaseInference(
  deps: Pick<CaseInferenceDeps, 'gatewayBaseUrl' | 'fetchImpl'>,
  input: { api: BenchmarkInferenceApi; body: string; headers: Record<string, string> }
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const upstream = await fetchImpl(
    `${deps.gatewayBaseUrl.replace(/\/+$/, '')}${CASE_INFERENCE_GATEWAY_PATH}`,
    {
      method: 'POST',
      headers: input.headers,
      body: JSON.stringify({ api: input.api, request: JSON.parse(input.body) as unknown }),
      redirect: 'manual',
    }
  );
  const headers: Record<string, string> = {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
  };
  for (const name of ADMISSION_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const cacheControl = upstream.headers.get('cache-control');
  if (cacheControl !== null) headers['cache-control'] = cacheControl;
  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * One case inference request, end to end. Exported so tests drive it without Hono.
 */
export async function handleCaseInference(
  deps: CaseInferenceDeps,
  input: { api: BenchmarkInferenceApi; request: Request; db: D1Database }
): Promise<Response> {
  // None of the route's own pre-admission refusals is model output, so each carries a stop:
  // an unmarked reply is graded as a zero, which would blame a model for a case that never
  // ran. Only an `admitted` reply is a measurement.
  if (!deps.capabilitySecret)
    return stopResponse(
      'infra_unavailable',
      failure('not_configured', 'Case inference is not configured.'),
      503
    );
  const invocation = await verifyCaseInferenceCapability(
    deps.capabilitySecret,
    input.request.headers,
    deps.now?.() ?? Date.now()
  );
  if (!invocation)
    return stopResponse(
      'infra_unavailable',
      failure('unauthorized', 'Case capability is not valid.'),
      401
    );

  const live = await liveCaseRun(input.db, invocation);
  if (!live)
    return stopResponse(
      'not_live',
      failure('case_not_live', 'This case is no longer running.'),
      409
    );

  // The runner mints one id per logical model call and reuses it on every retry of the same
  // HTTP request, so a duplicated delivery cannot admit twice. Without it there is no
  // one-time admit, so the request is refused rather than given a fresh identity.
  const modelRequestId = input.request.headers.get(BENCHMARK_MODEL_REQUEST_ID_HEADER);
  if (!modelRequestId || !z.uuid().safeParse(modelRequestId).success)
    return jsonResponse(
      failure('missing_model_request_id', 'Case request is missing its model request id.'),
      400
    );

  const cancelled = () =>
    stopResponse(
      'cancelled',
      failure('cancelled', 'Case request was cancelled before admission.'),
      499
    );
  // A paused runner must not start a new call, and reading a body whose signal already
  // aborted rejects: treat both as "cancelled before admission", never as an upstream try.
  if (input.request.signal.aborted) return cancelled();
  let body: Awaited<ReturnType<typeof readRequestBody>>;
  try {
    body = await readRequestBody(input.request, invocation);
  } catch {
    return cancelled();
  }
  if (!body.ok) return jsonResponse(body.response, 400);

  if (input.request.signal.aborted) return cancelled();

  if (!deps.resolvePayer)
    // No payer boundary means an unauthenticated inference call would bill nobody. Nothing
    // was selected or spent, so this is an infrastructure stop, never a money verdict.
    return stopResponse(
      'infra_unavailable',
      failure('gateway_jit_unavailable', 'Case inference billing is unavailable.'),
      503
    );
  // Try each payer the store offers until one is admitted. Only an authenticated,
  // pre-provider payment/identity refusal (or a stale assignment) moves to the next account:
  // a raw provider 402/403, a transport failure or an admission-unavailable answer stops here
  // because an upstream call may already have happened.
  const startTime = deps.now?.() ?? Date.now();
  const triedAssignments = new Set<string>();
  // Labelled so the refusal branches below can distinguish "next payer" from "retry this
  // same signed attempt after booking its prior receipt".
  payerLoop: for (;;) {
    if ((deps.now?.() ?? Date.now()) - startTime >= PAYER_ATTEMPT_DEADLINE_MS) {
      // Payers may remain untried: this is not "nobody can pay", so it must not read as one.
      return stopResponse(
        'infra_unavailable',
        failure('admission_unavailable', 'Payer selection did not finish in time; retry.'),
        503
      );
    }
    const selection = await deps.resolvePayer({ invocation, api: input.api, modelRequestId });
    const noPayer = (message: string) =>
      stopResponse('no_payer', failure('no_payer', message), 402);
    if (!selection) {
      // Every candidate the store could offer was refused. The answer is our own canonical
      // verdict, never a replayed gateway body (which could carry a raw provider refusal):
      // a typed pre-provider money result the runner may pause on, not a gateway outage.
      return noPayer('No payer is available for this case.');
    }
    if ('refused' in selection) {
      if (selection.refused === 'permanently_failed')
        // Terminal registry state for this exact pair: no payer is detached or charged and
        // other lanes keep running. Retrying cannot help until an operator re-admits the
        // model, so the answer is not retryable and is not a payment refusal.
        return stopResponse(
          'model_permanently_failed',
          failure(
            'permanently_failed',
            'This model is permanently failed and cannot be benchmarked.'
          ),
          409
        );
      // A selection this worker cannot sign for (e.g. an organization payer without a member)
      // is a pre-provider refusal, but the envelope carries a typed reason so the runner can
      // tell it from an infrastructure outage: only `no_payer` may pause as unfunded, and
      // this answer is neither an HTTP 502/503 nor a payment verdict.
      return noPayer('No payer is available for this case.');
    }
    const payer: CaseInferencePayer = selection;
    // A store that hands back the same assignment again means it has no other candidate:
    // stop rather than loop, and never call the same attempt twice.
    if (triedAssignments.has(payer.assignmentId))
      return noPayer('No other payer is available for this case.');
    triedAssignments.add(payer.assignmentId);

    // Book this exact payer's older native receipts BEFORE the gateway reads its balance, and
    // wait for this pool account's own outstanding permit to clear. One reconcile covers both,
    // bounded by this request's remaining budget and abort, and nothing is forwarded while it
    // runs. `pending` means the money state is unresolved: fail visibly without a provider call
    // rather than forwarding on a read we know is stale.
    const priorReceipt = await awaitPriorReceiptBooking(
      deps,
      input.db,
      modelRequestId,
      payer,
      startTime + PAYER_ATTEMPT_DEADLINE_MS,
      input.request.signal
    );
    // Re-checked here too: the wait can consume the whole budget or the caller can disconnect
    // while it runs, and neither may end in a forward.
    if (input.request.signal.aborted) return cancelled();
    if ((deps.now?.() ?? Date.now()) - startTime >= PAYER_ATTEMPT_DEADLINE_MS)
      return stopResponse(
        'infra_unavailable',
        failure('admission_unavailable', 'Payer selection did not finish in time; retry.'),
        503
      );
    if (priorReceipt === 'pending')
      // Still outstanding at the deadline. Keep the money state pending: not a funding verdict,
      // nothing detached, nothing graded, and no provider call opened for this attempt.
      return stopResponse(
        'infra_unavailable',
        failure(
          'receipt_unconfirmed',
          'An earlier admitted call for this case is still awaiting its native receipt.'
        ),
        409
      );

    {
      let response: Response;
      try {
        response = await forwardCaseInference(deps, {
          api: input.api,
          body: body.body,
          headers: caseUpstreamHeaders(input.request.headers, payer),
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'benchmark_case_inference_failed',
            caseId: invocation.caseId,
            error: error instanceof Error ? error.message : 'unknown',
          })
        );
        // The gateway call itself did not complete, so admission is unknown: no provider call is
        // proven either way and nothing here is model output. A trusted non-model stop lets the
        // runner refuse to grade it; whether this generation may be requeued is decided by the
        // exact D1 admit/attempt guard downstream, never by this status or any CLI cost.
        return stopResponse(
          'infra_unavailable',
          failure('upstream_error', 'Case upstream is unavailable.'),
          502
        );
      }

      // Admission is affirmative, never inferred from the absence of a refusal. A reply that
      // never reached the admit callback — a misconfigured callback URL, a route 500, a proxy
      // error — carries no admission header at all, and treating that as admitted is what let a
      // pre-provider 503 grade a zero and readify a profile. Only an explicit `admitted` is a
      // provider call this route may stream.
      const admission = response.headers.get('x-kilo-benchmark-admission');
      if (admission === 'admitted') {
        if (response.body === null) return response;
        // `Response.body` is `ReadableStream<any>` in the DOM lib; this route only ever forwards
        // the gateway's byte stream, which is what `admittedReplyStream` reads.
        const providerBody = response.body as ReadableStream<Uint8Array>;
        return new Response(admittedReplyStream(providerBody, deps.waitUntil), {
          status: response.status,
          headers: response.headers,
        });
      }

      // Not admitted. A reply with no admission fact is not a refusal this route can classify:
      // no provider call is proven either way, so it must not be graded and must not be retried
      // automatically as a fresh paid attempt.
      if (admission !== 'refused')
        return stopResponse(
          'infra_unavailable',
          failure(
            'admission_unknown',
            'The gateway answered without an admission fact; this case was not measured.'
          ),
          response.status >= 400 ? response.status : 503
        );

      const refusal = refusalReason(
        response,
        await response
          .clone()
          .json()
          .catch(() => null)
      );
      if (refusal === 'outstanding_receipt') {
        // The gateway still sees this payer's earlier permit as unbooked, even though we waited
        // for it before forwarding. Do not replay: a second forward would open a provider call
        // that nobody has re-checked against a fresh credit read. Keep the money state pending —
        // no detach, no grade, no funding pause — and let the caller retry later.
        return stopResponse(
          'infra_unavailable',
          failure(
            'receipt_unconfirmed',
            'An earlier admitted call for this case is still awaiting its native receipt.'
          ),
          409
        );
      }
      if (refusal !== null && RECEIPT_UNCONFIRMED_REFUSALS[refusal] === true) {
        // A previous attempt's receipt has not landed, so this reply is not model output and
        // must never be graded. Keep the payer and the original model request: the money state
        // is unproven, and a pending receipt must never be read as "free to call again".
        //
        // The stop is infrastructure, not a money verdict, so the runner neither pauses the plan
        // nor charges this attempt. Whether this generation may be requeued is decided by the
        // exact D1 admit/attempt guard downstream: if it was already admitted the guard refuses
        // and the case is quarantined rather than replayed, which is why this branch carries no
        // retryable status of its own.
        return stopResponse(
          'infra_unavailable',
          failure(
            'receipt_unconfirmed',
            'Native usage for an earlier attempt is not confirmed yet.'
          ),
          409
        );
      }
      if (refusal !== null && ROTATABLE_REFUSALS[refusal] === true) {
        if (DETACHING_REFUSALS[refusal] === true) {
          // Only a real payment/identity failure retires the account for this generation.
          const refused = await deps.refusePayer?.({ payer, invocation, reason: refusal });
          // The store could not prove another candidate may be tried, so this is the decisive
          // answer: our own canonical money verdict, never the gateway's body replayed to the
          // runner. It is correct even after an earlier call of this case already billed — that
          // charge stays, and the runner pauses instead of grading this refusal.
          if (!refused)
            return stopResponse(
              'no_payer',
              failure('no_payer', 'No other payer can fund this case.'),
              402
            );
        }
        // `platform_joined` / `payer_changed` / `attempt_superseded` are not the account's
        // fault: the old selection is simply superseded. Loop again so the store resolves the
        // same model request under the new authority (Kilo coverage or a fresh candidate); the
        // repeated assignment guard stops the loop if the store has nothing new to offer.
        continue payerLoop;
      }
      // Pre-provider refusals whose meaning this route owns: answer them as our own typed
      // verdict so the runner never has to interpret a gateway body to classify the case.
      // `permanently_failed` is a distinct stop, never a payment refusal.
      if (refusal === 'permanently_failed')
        return stopResponse(
          'model_permanently_failed',
          failure(
            'permanently_failed',
            'This model is permanently failed and cannot be benchmarked.'
          ),
          409
        );
      // The case is no longer live for this generation. Nothing reached a provider, so this is
      // its own terminal class: not a pause, not a model outcome, not an outage.
      if (refusal === 'case_paused' || refusal === 'generation_closed' || refusal === 'not_live')
        return stopResponse(
          'not_live',
          failure('case_not_live', 'This case is no longer running its admitted generation.'),
          409
        );
      // The signed envelope itself was rejected: missing, unsigned, malformed or expired. That
      // proves nothing about the payer — the gateway never resolved it — so this must never
      // rotate to another account, detach one, or charge anything. Nothing was dispatched, so
      // the model request is not fenced as ambiguous either. It is a bug in the credential this
      // Worker minted, so it surfaces as infrastructure rather than a funding or model verdict.
      if (refusal === 'assignment_invalid')
        return stopResponse(
          'infra_unavailable',
          failure(
            'assignment_invalid',
            'This Worker signed an assignment the gateway rejected; check the signing secret and envelope.'
          ),
          503
        );
      // The admit callback itself was unreachable or answered 5xx: a proven pre-provider
      // infrastructure stop. Nothing was dispatched, so the lane retries through normal
      // admission under the usual fence rather than grading or pausing the case.
      if (refusal === 'admission_unavailable')
        return stopResponse(
          'infra_unavailable',
          failure('admission_unavailable', 'The gateway could not confirm admission; retry.'),
          503
        );
      // A refusal this route cannot classify: it may already have committed work, so it must
      // not be graded and must not be replayed automatically. Answer our own trusted ambiguous
      // stop instead of forwarding a body the runner would have to interpret.
      return stopResponse(
        'infra_unavailable',
        failure(
          'admission_unknown',
          'The gateway refused this case without a classifiable reason.'
        ),
        response.status >= 400 ? response.status : 503
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Production wiring: store-selected payer, signed assignment, admission callback.
// ---------------------------------------------------------------------------------------------

async function signGatewayAssignment(
  secret: string,
  assignment: BenchmarkGatewayAssignment
): Promise<{ authorization: string; assignmentHeader: string }> {
  const token = await deriveCallbackToken({
    secret,
    scope: BENCHMARK_GATEWAY_ASSIGNMENT_SCOPE,
    resourceParts: benchmarkGatewayAssignmentParts(assignment),
  });
  return {
    authorization: `Bearer ${token}`,
    assignmentHeader: bytesToBase64url(new TextEncoder().encode(JSON.stringify(assignment))),
  };
}

export type CaseInferenceBindings = {
  BENCH_DB: D1Database;
  KILO_WEB_API_BASE_URL: string;
  INTERNAL_API_SECRET_PROD: SecretsStoreSecret;
};

function selectedModelRequest(
  results: D1Result<unknown>[] | undefined
): PaidModelRequestRow | null {
  if (!results) return null;
  const last = results[results.length - 1];
  const row = last?.results?.[0];
  return row ? (row as unknown as PaidModelRequestRow) : null;
}

/**
 * Production payer resolution: one store selection per model request, signed as the
 * gateway's assignment envelope. Nothing here invents an identity — when the store cannot
 * select a funded candidate for this exact running generation the request is refused.
 */

/** The saved-pool project frozen in the plan of exactly the request that pays this case. */
async function readPoolProjectFor(db: D1Database, poolRequestId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT quote.plan FROM paid_benchmark_requests AS request
      JOIN paid_benchmark_quotes AS quote ON quote.id = request.quote_id
      WHERE request.id = ? LIMIT 1`
    )
    .bind(poolRequestId)
    .first<{ plan: string }>();
  if (!row) return null;
  try {
    const parsed = PaidBenchmarkPlanSchema.safeParse(JSON.parse(row.plan));
    return parsed.success ? parsed.data.projectId : null;
  } catch {
    return null;
  }
}

/**
 * The run snapshot's benchmark identity: the actor every case runs as and, for platform
 * coverage, the organization a platform call bills. Read from the exact run the case belongs
 * to, never from whichever config row happens to exist.
 */
async function readRunBenchmarkIdentity(
  db: D1Database,
  runId: string
): Promise<{
  benchmarkUserId: string | null;
  benchmarkOrgId: string | null;
  router: string;
  repetitions: number;
} | null> {
  const row = await db
    .prepare(
      `SELECT benchmark_user_id, benchmark_org_id, router, repetitions
      FROM benchmark_runs WHERE id = ?`
    )
    .bind(runId)
    .first<{
      benchmark_user_id: string | null;
      benchmark_org_id: string | null;
      router: string;
      repetitions: number;
    }>();
  return row
    ? {
        benchmarkUserId: row.benchmark_user_id,
        benchmarkOrgId: row.benchmark_org_id,
        router: row.router,
        repetitions: row.repetitions,
      }
    : null;
}

/** The selected pool request's own actor: the member whose allowance funds a pool call. */
async function readPoolRequestActorUserId(
  db: D1Database,
  poolRequestId: string
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT actor_user_id FROM paid_benchmark_requests WHERE id = ?`)
    .bind(poolRequestId)
    .first<{ actor_user_id: string | null }>();
  const actor = row?.actor_user_id?.trim() ?? '';
  return actor.length > 0 ? actor : null;
}

export async function createCaseInferenceDeps(
  env: CaseInferenceBindings,
  fetchImpl?: typeof fetch
): Promise<CaseInferenceDeps> {
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  const selectPayer: CaseInferencePayerResolver = async ({ invocation, api, modelRequestId }) => {
    const key = caseKeyFromInvocation(invocation);
    const run = await readPaidCaseRun(env.BENCH_DB, key);
    if (!run || run.status !== 'running' || run.generation !== invocation.generation) return null;
    // A pair the registry already diagnosed as terminally failed can never be admitted: no
    // selection, no detach of a solvent payer, no billing-failure count. Only this pair is
    // affected; other lanes of the same case continue.
    if (!run.executor_run_id) return null;

    // Select first: only a `selecting` row may be signed, and selection is what copies the
    // winning pool request (or the platform latch) onto the row. Nothing is admitted here —
    // `/internal/case-admit` is the only consumer of an assignment.
    const identity = await readRunBenchmarkIdentity(env.BENCH_DB, run.executor_run_id);
    if (!identity || !identity.benchmarkUserId) return null;
    // The veto is evaluated against this run's own router and repetition count, so a verdict
    // from another measurement never blocks this one.
    const veto = await permanentFailureReason(env.BENCH_DB, key, {
      router: identity.router,
      repetitions: identity.repetitions,
    });
    if (veto) return refused('permanently_failed');
    const assignmentId = crypto.randomUUID();
    const usageId = createUsageId();
    const selected = await env.BENCH_DB.batch(
      selectPaidModelRequestPayerStatements(env.BENCH_DB, {
        key,
        generation: invocation.generation,
        modelRequestId,
        assignmentId,
        api,
        executorUserId: identity.benchmarkUserId,
        usageId,
        platformOrganizationId: identity.benchmarkOrgId,
      })
    );
    const row = selectedModelRequest(selected);
    if (!row || row.state !== 'selecting') return null;
    if (row.assignment_id !== assignmentId || row.usage_id !== usageId) return null;
    if (row.api !== api) return null;
    // The executor is the run's benchmark identity and the actor is the paying member; they
    // are different accounts for an owner pool, so never compare one to the other.
    if (row.executor_user_id !== null && row.executor_user_id !== identity.benchmarkUserId)
      return null;

    if (row.platform_covered === 1) {
      const platformOrgId = row.platform_organization_id ?? identity.benchmarkOrgId;
      if (!platformOrgId || row.pool_request_id !== null) return null;
      const platformAssignment: BenchmarkGatewayAssignment = {
        ...invocation,
        api,
        modelRequestId,
        assignmentId,
        requestId: null,
        usageId,
        payer: null,
        actorUserId: identity.benchmarkUserId,
        executorUserId: identity.benchmarkUserId,
        platformOrganizationId: platformOrgId,
        projectId: BENCHMARK_PLATFORM_PROJECT_ID,
      };
      const signed = await signGatewayAssignment(secret, platformAssignment);
      return {
        // A platform-covered call has no pool owner: Kilo pays. The two owner fields exist
        // only because this summary type is shared with pool payers, and the refusal path
        // that reads them is never reached for a platform selection.
        ownerType: 'user',
        ownerId: '',
        modelRequestId,
        assignmentId,
        usageId,
        requestId: null,
        executorUserId: identity.benchmarkUserId,
        projectId: BENCHMARK_PLATFORM_PROJECT_ID,
        platformOrganizationId: platformOrgId,
        headers: {
          [BENCHMARK_ASSIGNMENT_HEADER]: signed.assignmentHeader,
          authorization: signed.authorization,
        },
      };
    }

    if (!row.pool_request_id || !row.owner_type || !row.owner_id) return null;
    if (row.platform_organization_id !== null) return null;
    // The project must be the one frozen for exactly the request that pays this call, and
    // the store must have stamped that same value on the row the receipt will match.
    const poolProject = await readPoolProjectFor(env.BENCH_DB, row.pool_request_id);
    if (poolProject === null) return null;
    // The row must already carry exactly this project: the receipt gate compares the stored
    // column, so signing a project the row does not hold would book nothing and could report
    // a false receipt. A row without it is not signable — the store must stamp it on select.
    if (row.project_id === null) return refused('payer_unavailable');
    if (row.project_id !== poolProject) return refused('payer_unavailable');
    // The store stamped this row with the selected request's own project and executor; the
    // actor is that request's `actor_user_id` — the member whose allowance funds the call,
    // which for an organization payer is the funding member, never the benchmark executor.
    const actorUserId = await readPoolRequestActorUserId(env.BENCH_DB, row.pool_request_id);
    if (actorUserId === null) return null;
    // A personal payer must be its own actor; the store/contracts enforce the same rule.
    if (row.owner_type === 'user' && actorUserId !== row.owner_id)
      return refused('payer_unavailable');
    const assignment: BenchmarkGatewayAssignment = {
      ...invocation,
      api,
      modelRequestId,
      assignmentId,
      requestId: row.pool_request_id,
      usageId,
      payer: { type: row.owner_type, id: row.owner_id },
      actorUserId,
      executorUserId: identity.benchmarkUserId,
      platformOrganizationId: null,
      projectId: poolProject,
    };
    const signed = await signGatewayAssignment(secret, assignment);
    return {
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      modelRequestId,
      assignmentId,
      usageId,
      requestId: row.pool_request_id,
      executorUserId: identity.benchmarkUserId,
      projectId: poolProject,
      platformOrganizationId: null,
      headers: {
        [BENCHMARK_ASSIGNMENT_HEADER]: signed.assignmentHeader,
        authorization: signed.authorization,
      },
    };
  };

  // A pre-provider refusal retires the SELECTED attempt (never an admitted one) and makes
  // that account ineligible for this generation, so the same model request can select the
  // next candidate. The store's mutator no-ops on anything not still `selected`.
  const refusePayer: NonNullable<CaseInferenceDeps['refusePayer']> = async ({
    payer,
    invocation,
    reason,
  }) => {
    const results = await env.BENCH_DB.batch(
      refusePaidModelRequestStatements(env.BENCH_DB, {
        key: caseKeyFromInvocation(invocation),
        generation: invocation.generation,
        modelRequestId: payer.modelRequestId,
        assignmentId: payer.assignmentId,
        reason,
      })
    );
    return results.some(result => Number(result.meta.changes ?? 0) > 0);
  };

  // Before the gateway reads a payer's balance, book whatever native usage that payer has
  // already committed. Only `recorded` receipts book; a pending one stays pending, so a debit
  // the gateway has not seen yet cannot be shadowed by a stale green read.
  const reconcilePayer: NonNullable<CaseInferenceDeps['reconcilePayer']> = async (
    payer,
    options = {}
  ) => {
    if (payer.platformOrganizationId !== null) return;
    if (payer.ownerId.length === 0) return;
    // The platform path bills the run's organization, not a pool owner, and has its own
    // coverage latch; a pool call reconciles the exact owner it will be charged against.
    await reconcilePaidPayerReceipts(env, {
      ownerType: payer.ownerType,
      ownerId: payer.ownerId,
      fetchImpl,
      // The caller's abort and remaining budget bound the native receipt read, so a slow
      // read cannot outlive the request that asked for it.
      signal: options.signal,
      deadline: options.deadline,
    }).catch((error: unknown) => {
      console.warn(
        JSON.stringify({
          event: 'benchmark_case_payer_reconcile_failed',
          error: error instanceof Error ? error.message : 'unknown',
        })
      );
    });
  };

  return {
    capabilitySecret: secret,
    gatewayBaseUrl: env.KILO_WEB_API_BASE_URL,
    resolvePayer: selectPayer,
    refusePayer,
    reconcilePayer,
    fetchImpl,
  };
}

/**
 * The gateway's authenticated admission callback: consume the exact assignment once, before
 * a provider call may start. A refusal here is terminal for that attempt (`retryable: false`),
 * so the gateway fences instead of reassigning an ambiguous call.
 */

/**
 * Constant-time check of the internal bearer the gateway sends. A plain string compare would
 * leak the shared secret's prefix through timing, so both sides are digested first (fixed
 * length) and then compared byte by byte with no early exit. An absent, malformed or
 * oversized header is rejected before any digest work.
 */
async function authorizedInternalBearer(
  authorization: string | null,
  secret: string
): Promise<boolean> {
  const prefix = 'Bearer ';
  if (!authorization || !authorization.startsWith(prefix)) return false;
  const presented = authorization.slice(prefix.length);
  if (presented.length === 0 || presented.length > MAX_INTERNAL_BEARER_LENGTH) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0 && presented.length === secret.length;
}

/**
 * Whether this pool account already holds an *outstanding* permit, anywhere.
 *
 * This mirrors `noOutstanding` in `paid-case-store.ts` exactly — the authoritative guard that
 * decides the admission — rather than approximating it. That guard is the pool account's own
 * row set, not a per-case one: `state = 'admitted'`, `platform_covered = 0`, same
 * `(owner_type, owner_id)`, a different model request. It is deliberately NOT scoped to a case
 * or generation, because a second admitted permit for the same account would let the gateway
 * fund two provider calls against one balance wherever the first one was spent.
 *
 * Two consequences fall out of mirroring it rather than inventing a predicate:
 * - a platform-covered prior permit never blocks (the guard skips it), so Kilo-paid multi-call
 *   work is untouched and platform callers must not wait;
 * - "outstanding" means still `admitted`. Booking the native receipt moves the row to
 *   `completed`, so no usage subquery is needed — and adding one would disagree with the guard
 *   it is meant to predict.
 *
 * The leading `state = 'admitted'` is what `IX_paid_model_requests_state` serves, so this reuses
 * the same indexed access as the guard instead of introducing a second scan.
 */
async function hasOutstandingPoolPermit(
  db: D1Database,
  ownerType: string | null,
  ownerId: string | null,
  modelRequestId: string
): Promise<boolean> {
  if (ownerType === null || ownerId === null || ownerType === '' || ownerId === '') return false;
  const row = await db
    .prepare(
      `SELECT 1 AS blocked FROM paid_model_requests AS outstanding
      WHERE outstanding.state = 'admitted' AND outstanding.platform_covered = 0
        AND outstanding.owner_type = ? AND outstanding.owner_id = ?
        AND outstanding.id <> ?
      LIMIT 1`
    )
    .bind(ownerType, ownerId, modelRequestId)
    .first<{ blocked: number }>();
  return row !== null;
}

/**
 * Wait, inside this request's own bounded budget, for this pool account's outstanding permit to
 * book.
 *
 * Back-to-back paid calls are ordinary, so hitting the store's pool-account rule is not a payer
 * failure — but it is also not permission to forward on a read we know is stale. This books the
 * known receipt (via the same reconciler the cron uses) and re-checks, up to a short deadline
 * and while the caller is still connected. Nothing is forwarded while it runs, so waiting
 * cannot open a provider call.
 *
 * The abort and budget checks run **first on every iteration**, including the one right after a
 * reconcile that may itself have taken longer than the budget: a receipt that lands during a
 * wait after the caller left is still not permission to forward. A platform-covered payer is not
 * subject to the pool-account guard at all, so it never waits.
 *
 * `clear` means the caller may forward. `pending` means it must not: the money state stays
 * pending.
 */
async function awaitPriorReceiptBooking(
  deps: CaseInferenceDeps,
  db: D1Database,
  modelRequestId: string,
  payer: CaseInferencePayer,
  requestDeadline: number,
  signal: AbortSignal | undefined
): Promise<'clear' | 'pending'> {
  // A platform-covered call bills the run's organization through the coverage latch, which the
  // pool-account guard skips entirely: Kilo-paid multi-call work must not wait on a pool receipt.
  if (payer.platformOrganizationId !== null) return 'clear';
  const now = () => deps.now?.() ?? Date.now();
  const outstanding = () =>
    hasOutstandingPoolPermit(db, payer.ownerType, payer.ownerId, modelRequestId);
  const budgetMs = Math.min(PRIOR_RECEIPT_WAIT_MS, requestDeadline - now());
  if (budgetMs <= 0) return (await outstanding()) ? 'pending' : 'clear';
  // Exactly one reconcile per request: the helper polls internally, so calling it in a loop
  // here would poll twice. Its awaits are bounded by the same deadline and abort.
  await deps.reconcilePayer?.(payer, { signal, deadline: now() + budgetMs });
  // Re-checked before accepting the answer, so a receipt that lands after the caller left or
  // after the budget ran out cannot authorize a forward.
  if (signal?.aborted === true || now() >= requestDeadline) return 'pending';
  return (await outstanding()) ? 'pending' : 'clear';
}

/**
 * Why this selection was superseded rather than duplicated, or null.
 *
 * `platform_joined`: Kilo latched coverage for this generation, so a signed *user* attempt
 * must never run; the same model request continues as a platform call.
 * `payer_changed`: the store replaced the selection with a newer assignment for the same
 * model request (a rotation), so this signed attempt is simply old.
 * Both are trusted, pre-provider, and must retire the attempt without marking the account
 * failed — only a real payment refusal does that.
 */
async function supersededSelectionReason(
  db: D1Database,
  key: PaidCaseKey,
  assignment: BenchmarkGatewayAssignment
): Promise<'platform_joined' | 'payer_changed' | null> {
  const stored = await readPaidModelRequest(db, assignment.modelRequestId);
  if (!stored || stored.state !== 'selecting') return null;
  if (stored.assignment_id !== null && stored.assignment_id !== assignment.assignmentId)
    return 'payer_changed';
  const latched = await readPaidCaseRun(db, key);
  if (assignment.payer !== null && latched?.platform_covered === 1) return 'platform_joined';
  return null;
}

/**
 * The authoritative actor/executor/project for an assignment, or null.
 *
 * - executor: the run's benchmark identity from the run snapshot (`benchmark_user_id`).
 * - actor: for a platform-covered call the platform benchmark identity; for a pool call the
 *   selected request's own `actor_user_id`, i.e. the human member whose allowance funds it
 *   (for an organization payer that is a member, never the benchmark bot).
 * - project: the frozen pool project of that request, or the platform project.
 *
 * Binding all three means an assignment cannot be replayed with a different actor while
 * keeping the payer and executor it was signed with.
 */
async function authoritativeCaseIdentity(
  db: D1Database,
  assignment: BenchmarkGatewayAssignment
): Promise<{ actorUserId: string; executorUserId: string; projectId: string } | null> {
  const run = await readPaidCaseRun(db, caseKeyFromInvocation(assignment));
  if (!run || !run.executor_run_id) return null;
  const runIdentity = await readRunBenchmarkIdentity(db, run.executor_run_id);
  if (!runIdentity || !runIdentity.benchmarkUserId) return null;
  if (assignment.requestId === null) {
    if (!runIdentity.benchmarkOrgId) return null;
    return {
      actorUserId: runIdentity.benchmarkUserId,
      executorUserId: runIdentity.benchmarkUserId,
      projectId: BENCHMARK_PLATFORM_PROJECT_ID,
    };
  }
  const poolActor = await readPoolRequestActorUserId(db, assignment.requestId);
  const poolProject = await readPoolProjectFor(db, assignment.requestId);
  if (poolActor === null || poolProject === null) return null;
  return {
    actorUserId: poolActor,
    executorUserId: runIdentity.benchmarkUserId,
    projectId: poolProject,
  };
}

export async function handleCaseAdmit(
  env: CaseInferenceBindings,
  authorization: string | null,
  body: unknown
): Promise<Response> {
  const secret = await env.INTERNAL_API_SECRET_PROD.get();
  if (!(await authorizedInternalBearer(authorization, secret)))
    return jsonResponse({ error: { code: 'unauthorized', message: 'Not authorized.' } }, 401);
  const parsed = BenchmarkCaseAdmitRequestSchema.safeParse(body);
  if (!parsed.success)
    return jsonResponse({ error: { code: 'invalid_admit', message: 'Invalid admission.' } }, 400);
  const assignment = parsed.data.assignment;
  const key = caseKeyFromInvocation(assignment);
  const run = await readPaidCaseRun(env.BENCH_DB, key);
  if (!run || run.status !== 'running' || run.generation !== assignment.generation)
    return jsonResponse({ decision: 'refuse', reason: 'case_paused', retryable: false }, 409);
  // A selection Kilo has since covered, or replaced, is not a duplicate: the same model
  // request continues under the new authority, and the old attempt is retired without
  // marking its account failed. This is checked before the identity test so a superseded row
  // never reports as a terminal duplicate.
  // The signed actor, executor and project must each match their authoritative source: the
  // selected request's own actor (a human member for an organization pool), the run's
  // benchmark identity, and that request's frozen quote project. Validating only the owner
  // would let an attempt be re-signed with a different actor.
  const authoritative = await authoritativeCaseIdentity(env.BENCH_DB, assignment);
  if (
    !authoritative ||
    assignment.actorUserId !== authoritative.actorUserId ||
    assignment.executorUserId !== authoritative.executorUserId ||
    assignment.projectId !== authoritative.projectId
  )
    return jsonResponse(
      { decision: 'refuse', reason: 'attempt_superseded', retryable: false },
      409
    );
  const superseded = await supersededSelectionReason(env.BENCH_DB, key, assignment);
  if (superseded !== null)
    return jsonResponse({ decision: 'refuse', reason: superseded, retryable: true }, 409);
  // What was signed must be exactly what this case selected: same native call, API, actor,
  // project, usage id, platform organization and payer. Anything else is not this attempt.
  const stored = await readPaidModelRequest(env.BENCH_DB, assignment.modelRequestId);
  const sameSignedAttempt =
    stored !== null &&
    stored.assignment_id === assignment.assignmentId &&
    stored.generation === assignment.generation &&
    stored.api === assignment.api &&
    stored.usage_id === assignment.usageId &&
    stored.project_id === assignment.projectId &&
    stored.platform_organization_id === assignment.platformOrganizationId &&
    stored.executor_user_id === assignment.executorUserId &&
    stored.pool_request_id === assignment.requestId &&
    (stored.platform_covered === 1 ? null : stored.owner_type) ===
      (assignment.payer?.type ?? null) &&
    (stored.platform_covered === 1 ? null : stored.owner_id) === (assignment.payer?.id ?? null);
  if (!sameSignedAttempt)
    return jsonResponse(
      { decision: 'refuse', reason: 'attempt_superseded', retryable: false },
      409
    );
  // This exact attempt was already consumed (admitted, settled, refused or cancelled). A
  // redelivery of the same signed call is a duplicate, not a new permit, and never a
  // supersession: the signature named exactly this attempt, so no second provider call runs.
  if (stored.state !== 'selecting')
    return jsonResponse({ decision: 'refuse', reason: 'duplicate_attempt', retryable: false }, 409);
  const results = await env.BENCH_DB.batch(
    admitPaidModelRequestStatements(env.BENCH_DB, {
      key,
      generation: assignment.generation,
      modelRequestId: assignment.modelRequestId,
      assignmentId: assignment.assignmentId,
    })
  );
  // Only the one-time `selecting → admitted` transition may admit a call. The store's typed
  // reader reports both the transition's own row count and its trailing row, so a duplicate
  // delivery — or an assignment that was never selected — changes 0 rows and is refused.
  // A row that merely exists must never authorize a second provider call.
  const { changed } = paidModelRequestAdmission(results);
  if (changed) return jsonResponse({ decision: 'admit' }, 200);

  // The transition wrote nothing. Distinguish a genuine duplicate from a trusted race that
  // this attempt may still win through the Worker:
  // - Kilo latched platform coverage for this generation after the user selection was
  //   signed: the platform pays, so the user attempt must not run and the account must not be
  //   marked failed. The Worker reselects the same model request as a platform call.
  // - the selection was replaced by a newer assignment: the same, through a fresh selection.
  const raced = await supersededSelectionReason(env.BENCH_DB, key, assignment);
  if (raced !== null)
    return jsonResponse({ decision: 'refuse', reason: raced, retryable: true }, 409);
  // The row is still `selecting` under this exact assignment and nothing superseded it, so a
  // store guard refused. Distinguish the one recoverable cause before answering generically.
  //
  // The authoritative guard is `noOutstanding`: this **pool account's** outstanding permit,
  // across cases and generations, with platform-covered rows exempt. If that is what refused,
  // the earlier permit — not the account — is why, and the caller waits for its receipt before
  // forwarding. Unbooked is all it proves: the native write may be in flight or genuinely
  // uncertain, so nothing about the balance is assumed. Nothing was dispatched for *this*
  // attempt either, so naming it precisely is safe.
  //
  // A platform-covered selection is skipped entirely: the guard bypasses it, so it can never be
  // the cause and Kilo-paid multi-call work must not be told to wait.
  //
  // Deliberately no reconcile-and-grant here: the gateway has already read this payer's
  // balance before calling us, so granting in place would authorize a provider call against a
  // read a debit may since have invalidated.
  //
  // Every other cause (detached pool, inactive request, no eligible candidate) stays the
  // generic retryable pre-provider answer, which carries no money verdict.
  if (
    stored !== null &&
    stored.platform_covered === 0 &&
    (await hasOutstandingPoolPermit(
      env.BENCH_DB,
      stored.owner_type,
      stored.owner_id,
      assignment.modelRequestId
    ))
  )
    return jsonResponse(
      { decision: 'refuse', reason: 'outstanding_receipt', retryable: true },
      409
    );
  return jsonResponse(
    { decision: 'refuse', reason: 'admission_unavailable', retryable: true },
    409
  );
}

/**
 * Register the proxy routes. They come before the backend-secret middleware because the
 * runner container and the gateway cannot hold it; the case capability and the signed
 * assignment are their credentials.
 */
export function registerCaseInferenceRoutes(app: Hono<HonoEnv>): void {
  const handleInference = async (c: Context<HonoEnv>) => {
    const api = caseInferenceApiFromPath(new URL(c.req.url).pathname);
    if (!api) return jsonResponse(failure('not_found', 'Unknown case inference route.'), 404);
    const deps = await createCaseInferenceDeps(c.env);
    // The real request context owns the drain: after the runner disconnects, Hono's
    // `waitUntil` keeps the provider stream finishing so the native usage row still commits.
    // `executionCtx` is absent only in direct unit calls, where the caller supplies its own.
    let executionCtx: ExecutionContext | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    const waitUntil = executionCtx
      ? (promise: Promise<unknown>) => executionCtx?.waitUntil(promise)
      : undefined;
    return handleCaseInference(
      { ...deps, waitUntil },
      { api, request: c.req.raw, db: c.env.BENCH_DB }
    );
  };
  for (const api of BenchmarkInferenceApiSchema.options)
    app.post(`${BENCHMARK_CASE_INFERENCE_PATH}/${api}`, handleInference);
  app.post(BENCHMARK_CASE_ADMIT_PATH, async c =>
    handleCaseAdmit(
      c.env,
      c.req.header('authorization') ?? null,
      await c.req.json().catch(() => null)
    )
  );
}
