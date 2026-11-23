import { Container } from '@cloudflare/containers';
import { BENCHMARK_MODEL_REQUEST_ID_HEADER } from '@kilocode/auto-routing-contracts';
import * as z from 'zod';
import { withCallerCancellation } from './caller-cancellation';
import { BENCHMARK_CASE_HEADER } from './case-inference-capability';
import {
  BENCHMARK_CASE_STOP_HEADER,
  CONTAINER_NOT_REACHED_PREFIX,
  DECIDER_CLI_TIMEOUT_MS,
  PAID_GENERATION_HEADER,
  PROBE_BODY_MAX_BYTES,
  PROBE_GATEWAY_ENDPOINTS,
  PROBE_RUNNER_HEADER,
  checkPaidCaseAdmission,
  decodePaidGenerationHeader,
  isContainerNotReachedBody,
  paidGenerationKey,
  trustedCaseStop,
  type PaidAdmissionCheck,
  type PaidAdmissionRefusalReason,
  type PaidCaseGeneration,
} from './cli-runner';

// A cancel outlives a Durable Object restart: the tombstone lives in object storage, so a
// late `/run` or `/probe` for that generation is refused even after the object is rebuilt.
const CANCELLED_GENERATION_TTL_MS = 15 * 60_000;
const CANCELLED_STORAGE_PREFIX = 'cancelled-generation:';
const PROBE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
// The caller's own timeout is shorter, so a live caller classifies its timeout itself; this
// margin only bounds a request whose caller vanished before its signal fired.
const PROBE_TIMEOUT_MARGIN_MS = 5_000;
const INTERNAL_HOST = 'container';

const PaidGenerationSchema = z.object({
  runId: z.string().min(1),
  token: z.string().min(1),
  model: z.string().min(1),
  variant: z.string(),
  rep: z.number().int(),
  caseId: z.string().min(1),
  attemptStartedAt: z.number().int().nonnegative(),
  canonicalGeneration: z.number().int().nonnegative().optional(),
  engineIdentity: z.string().min(1).optional(),
});

const CaseInferenceSchema = z.object({
  url: z.string().regex(/^https?:\/\//),
  authorization: z.string().regex(/^Bearer \S+$/),
  invocation: z.string().regex(/^[A-Za-z0-9_-]+$/),
  invocationHeader: z
    .string()
    .regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/)
    .optional(),
});

const ProbeRequestSchema = z.object({
  execution: PaidGenerationSchema,
  endpoint: z.enum(PROBE_GATEWAY_ENDPOINTS),
  inference: CaseInferenceSchema,
  body: z.string().max(PROBE_BODY_MAX_BYTES),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(15 * 60_000)
    .optional(),
});

const CancelRequestSchema = z.object({ execution: PaidGenerationSchema });

const CASE_INFERENCE_PATH = '/case-inference';

function runnerState(state: string, status: number): Response {
  return Response.json(
    { error: state, cancelled: state === 'cancelled' },
    { status, headers: { [PROBE_RUNNER_HEADER]: state } }
  );
}

function cancelledRunResponse(): Response {
  return Response.json({ error: 'case cancelled', cancelled: true }, { status: 409 });
}

function notStartedRunResponse(reason: PaidAdmissionRefusalReason): Response {
  return Response.json(
    { error: 'case not live', started: false, cancelled: false, reason },
    { status: reason === 'ledger_unavailable' ? 503 : 409 }
  );
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  return JSON.parse(text);
}

type CappedBody = { bytes: Uint8Array } | { failure: 'too_large' | 'aborted' };

async function readCapped(response: Response, signal: AbortSignal): Promise<CappedBody> {
  if (response.body === null) return { bytes: new Uint8Array(0) };
  // workers-types types the response body reader loosely here; the bytes are always chunks.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > PROBE_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { failure: 'too_large' };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { failure: signal.aborted ? 'aborted' : 'too_large' };
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

export class BenchRunnerContainer extends Container<Env> {
  defaultPort = 3000;
  // Only requests into the container renew this timer; the container's own result posts do
  // not. It covers the CLI timeout plus the whole result-delivery schedule in server.mjs.
  sleepAfter = '10m';
  // The CLI resolves every gateway endpoint from KILO_API_URL. Production
  // points at the real gateway; local dev overrides it via .dev.vars so the
  // benchmark runs against the local apps/web instance.
  envVars = { KILO_CLI_API_URL: this.env.KILO_CLI_API_URL };
  // Direct probe calls run in this object, not in the container, so the generation's abort
  // controller survives while another isolate asks to cancel it.
  private readonly probeRuns = new Map<string, AbortController>();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/admin/destroy') {
      await this.destroy();
      return new Response('destroyed');
    }
    if (url.host !== INTERNAL_HOST) {
      return new Response('not found', { status: 404 });
    }
    if (request.method === 'POST' && url.pathname === '/probe') {
      // Handled here, before any container call: a probe must never start a CLI container.
      return this.runProbe(request);
    }
    if (request.method === 'POST' && url.pathname === '/cancel') {
      return this.cancelPaidCase(request);
    }
    if (request.method === 'POST' && url.pathname === '/run') {
      const refused = await this.refusedRun(request);
      if (refused !== null) return refused;
    }
    const response = await super.fetch(withCallerCancellation(request));
    if (response.status !== 500) return response;
    const body = await response.text();
    // A request that never reached the server cannot have started a paid call, so it
    // takes the same retryable 503 as a missing instance.
    if (isContainerNotReachedBody(body)) {
      return new Response(`${CONTAINER_NOT_REACHED_PREFIX}${body}`, { status: 503 });
    }
    // text() decoded the body, so the upstream encoding and length no longer describe it.
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // The paid generation of a `/run` is carried in a header so this guard never buffers the
  // case prompt. A generation cancelled while its request was in flight, or one that is no
  // longer the running canonical generation, is refused before the container is asked to
  // start; an unverifiable admission refuses too (fail closed).
  private async refusedRun(request: Request): Promise<Response | null> {
    const header = request.headers.get(PAID_GENERATION_HEADER);
    if (header === null) return null;
    const generation = decodePaidGenerationHeader(header);
    if (generation === null) {
      return Response.json({ error: 'invalid paid generation header' }, { status: 400 });
    }
    if (await this.isGenerationCancelled(generation)) return cancelledRunResponse();
    const admission = await this.admission(generation);
    if (!admission.live) return notStartedRunResponse(admission.reason);
    return null;
  }

  private async cancelPaidCase(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await readJson(request);
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    const parsed = CancelRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error:
            'execution with runId, model, variant, rep, caseId and attemptStartedAt is required',
        },
        { status: 400 }
      );
    }
    const generation = parsed.data.execution;
    // Durable first: even if the rest of this handler fails or the object restarts, the
    // generation cannot start later.
    await this.recordCancellation(generation);

    const key = paidGenerationKey(generation);
    const probe = this.probeRuns.get(key);
    if (probe !== undefined) {
      this.probeRuns.delete(key);
      probe.abort('cancelled');
      return Response.json({ cancelled: true, state: 'killed' });
    }
    const state = await this.getState();
    if (state.status !== 'running' && state.status !== 'healthy') {
      return Response.json({ cancelled: false, state: 'not_running' });
    }
    // The request is rebuilt without the caller's signal: a pause must stop the subprocess
    // even when the request that carries it ends. An instance with no running container has
    // no subprocess of any generation, and answering above keeps it asleep.
    return super.fetch(
      new Request(`http://${INTERNAL_HOST}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ execution: generation }),
      })
    );
  }

  private async runProbe(request: Request): Promise<Response> {
    let payload: unknown;
    try {
      payload = await readJson(request);
    } catch {
      return runnerState('invalid', 400);
    }
    const parsed = ProbeRequestSchema.safeParse(payload);
    if (!parsed.success) return runnerState('invalid', 400);
    const { execution, endpoint, inference, body, timeoutMs } = parsed.data;
    if (await this.isGenerationCancelled(execution)) return runnerState('cancelled', 409);
    const admission = await this.admission(execution);
    if (!admission.live) {
      return runnerState(admission.reason, admission.reason === 'ledger_unavailable' ? 503 : 409);
    }

    const key = paidGenerationKey(execution);
    if (this.probeRuns.has(key)) return runnerState('duplicate', 409);
    const controller = new AbortController();
    this.probeRuns.set(key, controller);
    const timer = setTimeout(
      () => controller.abort('timeout'),
      (timeoutMs ?? DECIDER_CLI_TIMEOUT_MS) + PROBE_TIMEOUT_MARGIN_MS
    );
    try {
      // The probe goes to the worker's case-inference route, never to a provider host: the
      // URL is built from the issued base and the fixed api, with the capability and the
      // signed invocation exactly as the CLI proxy sends them.
      const target = new URL(`${CASE_INFERENCE_PATH}/${endpoint}`, inference.url);
      // One id per actual probe model request. Repeated delivery of this same outbound
      // request keeps it, so a duplicated transport cannot admit twice; a new probe mints a
      // new one.
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          authorization: inference.authorization,
          [inference.invocationHeader ?? BENCHMARK_CASE_HEADER]: inference.invocation,
          [BENCHMARK_MODEL_REQUEST_ID_HEADER]: crypto.randomUUID(),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body,
        signal: controller.signal,
      });
      const read = await readCapped(response, controller.signal);
      if ('failure' in read) {
        return controller.signal.aborted
          ? this.abortedProbe(controller)
          : runnerState('too_large', 502);
      }
      // A Worker refusal (no payer, paused, superseded) carries a trusted stop; an admitted
      // upstream reply never does, so a provider body cannot stop the case.
      const stop = trustedCaseStop(response);
      const headers: Record<string, string> = {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      };
      if (stop !== null) headers[BENCHMARK_CASE_STOP_HEADER] = stop.reason;
      return new Response(read.bytes, { status: response.status, headers });
    } catch {
      if (controller.signal.aborted) return this.abortedProbe(controller);
      return runnerState('gateway_error', 502);
    } finally {
      clearTimeout(timer);
      if (this.probeRuns.get(key) === controller) this.probeRuns.delete(key);
    }
  }

  private abortedProbe(controller: AbortController): Response {
    return controller.signal.reason === 'cancelled'
      ? runnerState('cancelled', 409)
      : runnerState('timeout', 504);
  }

  private async isGenerationCancelled(generation: PaidCaseGeneration): Promise<boolean> {
    const key = CANCELLED_STORAGE_PREFIX + paidGenerationKey(generation);
    try {
      const expiresAt = await this.ctx.storage.get<number>(key);
      if (expiresAt === undefined) return false;
      if (expiresAt > Date.now()) return true;
      await this.ctx.storage.delete(key);
      return false;
    } catch (error) {
      this.logStorageFailure('read', generation, error);
      return false;
    }
  }

  private async recordCancellation(generation: PaidCaseGeneration): Promise<void> {
    const now = Date.now();
    try {
      const stored = await this.ctx.storage.list<number>({ prefix: CANCELLED_STORAGE_PREFIX });
      for (const [key, expiresAt] of stored) {
        if (expiresAt <= now) await this.ctx.storage.delete(key);
      }
      await this.ctx.storage.put(
        CANCELLED_STORAGE_PREFIX + paidGenerationKey(generation),
        now + CANCELLED_GENERATION_TTL_MS
      );
    } catch (error) {
      // The cancellation still stops the call and the ledger recheck still applies; only
      // this restart-surviving note is lost, which the caller can re-send.
      this.logStorageFailure('write', generation, error);
    }
  }

  private logStorageFailure(
    operation: 'read' | 'write',
    generation: PaidCaseGeneration,
    error: unknown
  ): void {
    console.warn(
      JSON.stringify({
        event: 'benchmark_runner_tombstone_failed',
        operation,
        runId: generation.runId,
        model: generation.model,
        rep: generation.rep,
        caseId: generation.caseId,
        attemptStartedAt: generation.attemptStartedAt,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }

  private async admission(generation: PaidCaseGeneration): Promise<PaidAdmissionCheck> {
    if (this.env.BENCH_DB === undefined) {
      return { live: false, reason: 'ledger_unavailable' };
    }
    return checkPaidCaseAdmission(this.env.BENCH_DB, generation);
  }
}
