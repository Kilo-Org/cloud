import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BENCHMARK_CASE_INFERENCE_PATH,
  BENCHMARK_MODEL_REQUEST_ID_HEADER,
  type BenchmarkCaseInvocation,
} from '@kilocode/auto-routing-contracts';
import { openPaidDatabase } from '../test/paid-benchmark-d1';
import { BENCHMARK_CASE_HEADER, issueCaseInferenceCapability } from './case-inference-capability';
import {
  BENCHMARK_CASE_STOP_HEADER,
  BENCHMARK_CASE_STOP_REASONS,
  CASE_INFERENCE_GATEWAY_PATH,
  caseInferenceApiFromPath,
  caseUpstreamHeaders,
  handleCaseInference,
  type CaseInferenceDeps,
  type CaseInferencePayer,
} from './case-inference';
import {
  BENCHMARK_CASE_STOP_HEADER as RUNNER_CASE_STOP_HEADER,
  BENCHMARK_CASE_STOP_REASONS as RUNNER_CASE_STOP_REASONS,
} from './cli-runner';

const SECRET = 'synthetic-case-inference-secret';
const GATEWAY = 'https://gateway.test';
const MODEL_REQUEST_ID = '44444444-4444-4444-8444-444444444444';

const INVOCATION: BenchmarkCaseInvocation = {
  engineIdentity: 'engine-test',
  runId: 'run-1',
  model: 'vendor/alpha',
  variant: 'high',
  caseId: 'case-a',
  repetition: 0,
  generation: 1,
  startedAt: Date.now(),
};

const PAYER: CaseInferencePayer = {
  ownerType: 'user',
  ownerId: 'user-1',
  modelRequestId: 'model-request-1',
  assignmentId: 'assignment-1',
  usageId: 'usage-1',
  requestId: 'request-1',
  executorUserId: 'bench-user',
  projectId: 'project-1',
  platformOrganizationId: null,
  headers: {
    'x-kilo-benchmark-assignment': 'assignment-envelope',
    authorization: 'Bearer signed',
  },
};

let sqlite: ReturnType<typeof openPaidDatabase>['sqlite'];
let db: D1Database;
let upstream: { url: string; init: RequestInit }[];
let gatewayReplies: Response[];

function seedRun(input: { status?: string; generation?: number; executorRunId?: string } = {}) {
  sqlite
    .prepare(
      `INSERT INTO benchmark_case_runs
        (engine_identity, model, variant, rep, case_id, status, generation, executor_run_id,
          executor_token, platform_covered, result_usable, created_at, updated_at, started_at)
      VALUES ('engine-test', 'vendor/alpha', 'high', 0, 'case-a', ?, ?, ?, 'token-1', 0, 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
    .run(input.status ?? 'running', input.generation ?? 1, input.executorRunId ?? 'run-1');
}

async function request(
  body: unknown = { model: 'vendor/alpha', messages: [{ role: 'user', content: 'hi' }] },
  options: {
    invocation?: BenchmarkCaseInvocation;
    authorization?: string;
    modelRequestId?: string;
  } = {}
): Promise<Request> {
  const issued = await issueCaseInferenceCapability(SECRET, options.invocation ?? INVOCATION);
  return new Request(`https://bench.test${BENCHMARK_CASE_INFERENCE_PATH}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: options.authorization ?? issued.authorization,
      [BENCHMARK_CASE_HEADER]: issued.invocationHeader,
      [BENCHMARK_MODEL_REQUEST_ID_HEADER]: options.modelRequestId ?? MODEL_REQUEST_ID,
    },
    body: JSON.stringify(body),
  });
}

function admissionHeaders(value: 'admitted' | 'refused'): Record<string, string> {
  return { 'x-kilo-benchmark-admission': value };
}

function deps(overrides: Partial<CaseInferenceDeps> = {}): CaseInferenceDeps {
  return {
    capabilitySecret: SECRET,
    gatewayBaseUrl: GATEWAY,
    resolvePayer: async () => PAYER,
    refusePayer: async () => true,
    fetchImpl: (async (url: string, init: RequestInit) => {
      upstream.push({ url, init });
      const reply = gatewayReplies.shift();
      if (!reply) throw new Error('no canned gateway reply');
      return reply;
    }) as unknown as typeof fetch,
    ...overrides,
  };
}

/** The JSON body the route forwarded, asserted rather than stringified blindly. */
function forwardedBody(init: RequestInit): unknown {
  if (typeof init.body !== 'string') throw new Error('forwarded body was not a string');
  return JSON.parse(init.body) as unknown;
}

/** Small helper so a test can drive one request through the exported handler. */
async function app_handle(depsValue: CaseInferenceDeps, requestValue: Request): Promise<Response> {
  return handleCaseInference(depsValue, { api: 'chat/completions', request: requestValue, db });
}

function sse(): Response {
  return new Response('data: {"ok":true}\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...admissionHeaders('admitted') },
  });
}

beforeEach(() => {
  const opened = openPaidDatabase();
  sqlite = opened.sqlite;
  db = opened.db;
  upstream = [];
  gatewayReplies = [];
  seedRun();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('case inference route shape', () => {
  it('accepts exactly the three inference APIs', () => {
    expect(caseInferenceApiFromPath(`${BENCHMARK_CASE_INFERENCE_PATH}/chat/completions`)).toBe(
      'chat/completions'
    );
    expect(caseInferenceApiFromPath(`${BENCHMARK_CASE_INFERENCE_PATH}/responses`)).toBe(
      'responses'
    );
    expect(caseInferenceApiFromPath(`${BENCHMARK_CASE_INFERENCE_PATH}/messages`)).toBe('messages');
    expect(caseInferenceApiFromPath(`${BENCHMARK_CASE_INFERENCE_PATH}/models`)).toBeNull();
    expect(caseInferenceApiFromPath('/case-inference/chat/completions/../x')).toBeNull();
  });

  it('strips caller identity and keeps only the signed assignment headers', () => {
    const incoming = new Headers({
      authorization: 'Bearer caller',
      [BENCHMARK_CASE_HEADER]: 'invocation',
      'x-kilo-benchmark-assignment': 'caller-supplied',
      'x-kilo-organization-id': 'org-1',
      'x-forwarded-for': '1.2.3.4',
      cookie: 'session=1',
      'content-type': 'text/plain',
      'openai-beta': 'assistants=v2',
    });
    expect(caseUpstreamHeaders(incoming, PAYER)).toEqual({
      'content-type': 'application/json',
      'x-kilo-benchmark-assignment': 'assignment-envelope',
      authorization: 'Bearer signed',
      'openai-beta': 'assistants=v2',
    });
  });
});

describe('case inference handler', () => {
  it('forwards an authenticated live generation through the single gateway route', async () => {
    gatewayReplies = [sse()];
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: {"ok":true}\n\n');
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.url).toBe(`${GATEWAY}${CASE_INFERENCE_GATEWAY_PATH}`);
    const first = upstream[0];
    if (!first) throw new Error('no forwarded request');
    expect(forwardedBody(first.init)).toEqual({
      api: 'chat/completions',
      request: { model: 'vendor/alpha', messages: [{ role: 'user', content: 'hi' }] },
    });
    const headers = upstream[0]?.init.headers as Record<string, string>;
    expect(headers['x-kilo-benchmark-assignment']).toBe('assignment-envelope');
    expect(headers.authorization).toBe('Bearer signed');
  });

  it('refuses an unsigned or tampered capability before any upstream call', async () => {
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(undefined, { authorization: 'Bearer forged' }),
      db,
    });
    expect(response.status).toBe(401);
    expect(upstream).toHaveLength(0);
  });

  it('refuses a case that is no longer live, an older generation, or another run', async () => {
    const notRunning = await (async () => {
      sqlite.prepare("UPDATE benchmark_case_runs SET status = 'settled', result_usable = 1").run();
      return handleCaseInference(deps(), {
        api: 'chat/completions',
        request: await request(),
        db,
      });
    })();
    expect(notRunning.status).toBe(409);

    sqlite.prepare("UPDATE benchmark_case_runs SET status = 'running'").run();
    const stale = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(undefined, { invocation: { ...INVOCATION, generation: 2 } }),
      db,
    });
    expect(stale.status).toBe(409);
    const foreignRun = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(undefined, { invocation: { ...INVOCATION, runId: 'run-other' } }),
      db,
    });
    expect(foreignRun.status).toBe(409);
    expect(upstream).toHaveLength(0);
  });

  it('refuses a body model that differs from the signed model or is an auto alias', async () => {
    const mismatch = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request({ model: 'vendor/other' }),
      db,
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: { code: 'model_mismatch' } });

    const auto = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request({ model: 'kilo-auto/efficient' }),
      db,
    });
    expect(auto.status).toBe(400);
    expect(await auto.json()).toMatchObject({ error: { code: 'auto_model_refused' } });
    expect(upstream).toHaveLength(0);
  });

  it('fails closed when no payer boundary is configured, never inventing a payer', async () => {
    const response = await handleCaseInference(deps({ resolvePayer: undefined }), {
      api: 'chat/completions',
      request: await request(),
      db,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'gateway_jit_unavailable' } });
    expect(upstream).toHaveLength(0);
  });

  it('refuses without an upstream call when no candidate may pay', async () => {
    const response = await handleCaseInference(deps({ resolvePayer: async () => null }), {
      api: 'responses',
      request: await request({ model: 'vendor/alpha', input: 'hi' }),
      db,
    });
    // A typed pre-provider money verdict: 402 with a code the runner may pause on, never a
    // gateway-unavailable 503 that would be read as infrastructure.
    expect(response.status).toBe(402);
    expect(await response.clone().json()).toMatchObject({ error: { code: 'no_payer' } });
    expect(upstream).toHaveLength(0);
  });

  it('keeps an admitted call terminal even when the provider answers 402', async () => {
    let refusals = 0;
    gatewayReplies = [
      new Response(JSON.stringify({ error: { code: 'provider_payment_failed' } }), {
        status: 402,
        headers: { 'content-type': 'application/json', ...admissionHeaders('admitted') },
      }),
    ];
    const response = await handleCaseInference(
      deps({
        refusePayer: async () => {
          refusals += 1;
          return true;
        },
      }),
      { api: 'chat/completions', request: await request(), db }
    );
    expect(response.status).toBe(402);
    expect(refusals).toBe(0);
    expect(upstream).toHaveLength(1);
  });

  it('rotates once on a trusted payment refusal that made no provider call', async () => {
    const refused = new Response(
      JSON.stringify({ error: { code: 'benchmark_payer_refused', reason: 'payment_refused' } }),
      {
        status: 402,
        headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
      }
    );
    gatewayReplies = [refused, sse()];
    let refusals = 0;
    const resolved: string[] = [];
    let assignments = 0;
    const response = await handleCaseInference(
      deps({
        // The store retires the refused attempt and hands out a *new* assignment for the
        // same model request; handing the same one back would be a repeat, not a rotation.
        resolvePayer: async ({ modelRequestId }) => {
          resolved.push(modelRequestId);
          assignments += 1;
          return { ...PAYER, assignmentId: `assignment-${assignments}` };
        },
        refusePayer: async () => {
          refusals += 1;
          return true;
        },
      }),
      { api: 'chat/completions', request: await request(), db }
    );
    expect(response.status).toBe(200);
    expect(refusals).toBe(1);
    expect(upstream).toHaveLength(2);
    // One model request keeps one identity across the rotation.
    expect(new Set(resolved).size).toBe(1);
  });

  it('tries every payer in turn, so A and B refusing still reaches C', async () => {
    const refusal = (reason: string) =>
      new Response(JSON.stringify({ error: { code: 'benchmark_payer_refused', reason } }), {
        status: 402,
        headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
      });
    gatewayReplies = [
      refusal('payment_refused'),
      refusal('payment_refused'),
      new Response('data: ok\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', ...admissionHeaders('admitted') },
      }),
    ];
    // Each resolve hands the store's next candidate: A, B, then C.
    const assigned = ['a', 'b', 'c'];
    let resolved = 0;
    let refusals = 0;
    const response = await handleCaseInference(
      deps({
        resolvePayer: async () => {
          const account = assigned[resolved];
          resolved += 1;
          return account
            ? { ...PAYER, ownerId: `user-${account}`, assignmentId: `assignment-${account}` }
            : null;
        },
        refusePayer: async () => {
          refusals += 1;
          return true;
        },
      }),
      { api: 'chat/completions', request: await request(), db }
    );
    expect(response.status).toBe(200);
    expect(refusals).toBe(2);
    expect(upstream).toHaveLength(3);
  });

  it('answers a real payment refusal that cannot rotate as its own no_payer verdict', async () => {
    gatewayReplies = [
      new Response(
        JSON.stringify({ error: { code: 'benchmark_payer_refused', reason: 'payment_refused' } }),
        {
          status: 402,
          headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
        }
      ),
    ];
    let resolved = 0;
    const response = await handleCaseInference(
      deps({
        resolvePayer: async () => {
          resolved += 1;
          return PAYER;
        },
        refusePayer: async () => false,
      }),
      { api: 'chat/completions', request: await request(), db }
    );
    // The store proved no other candidate may be tried, so the case stops on our own money
    // verdict rather than a replayed gateway body the runner would have to interpret.
    expect(response.status).toBe(402);
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('no_payer');
    expect(await response.json()).toMatchObject({ error: { code: 'no_payer' } });
    expect(resolved).toBe(1);
    expect(upstream).toHaveLength(1);
  });

  it('rejects a request without a model request id, and forwards the runner id on retries', async () => {
    const missing = await app_handle(deps(), await request(undefined, { modelRequestId: '' }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'missing_model_request_id' } });
    expect(upstream).toHaveLength(0);

    gatewayReplies = [
      new Response('data: one\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', ...admissionHeaders('admitted') },
      }),
      new Response('data: two\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', ...admissionHeaders('admitted') },
      }),
    ];
    const seen: string[] = [];
    const first = await app_handle(
      deps({ resolvePayer: async input => (seen.push(input.modelRequestId), PAYER) }),
      await request()
    );
    await first.text();
    const retry = await app_handle(
      deps({ resolvePayer: async input => (seen.push(input.modelRequestId), PAYER) }),
      await request()
    );
    await retry.text();
    // The same HTTP delivery retried keeps one model request identity: one native call each.
    expect(seen).toEqual([MODEL_REQUEST_ID, MODEL_REQUEST_ID]);
  });

  it('never rotates on an admission-unavailable refusal', async () => {
    gatewayReplies = [
      new Response(
        JSON.stringify({
          error: { code: 'benchmark_payer_refused', reason: 'admission_unavailable' },
        }),
        {
          status: 503,
          headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
        }
      ),
    ];
    let refusals = 0;
    const response = await handleCaseInference(
      deps({
        refusePayer: async () => {
          refusals += 1;
          return true;
        },
      }),
      { api: 'chat/completions', request: await request(), db }
    );
    expect(response.status).toBe(503);
    expect(refusals).toBe(0);
    expect(upstream).toHaveLength(1);
  });

  it('reports an upstream transport failure as a non-model stop without retrying it', async () => {
    let calls = 0;
    const response = await handleCaseInference(
      deps({
        fetchImpl: (async () => {
          calls += 1;
          throw new Error('socket closed');
        }) as unknown as typeof fetch,
      }),
      { api: 'chat/completions', request: await request(), db }
    );
    expect(response.status).toBe(502);
    expect(calls).toBe(1);
    // A dropped gateway call proves nothing about a provider, so the runner must not grade it.
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('infra_unavailable');
    expect(await response.json()).toMatchObject({ error: { code: 'upstream_error' } });
  });

  it('refuses a request whose caller disconnected before admission', async () => {
    const controller = new AbortController();
    const pending = await request();
    controller.abort();
    const withSignal = new Request(pending.url, {
      method: 'POST',
      headers: pending.headers,
      body: await pending.text(),
      signal: controller.signal,
    });
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: withSignal,
      db,
    });
    expect(response.status).toBe(499);
    expect(upstream).toHaveLength(0);
  });

  it('finishes the provider stream after the runner aborts mid-response', async () => {
    // A provider stream that only completes if the Worker keeps reading it: the native usage
    // writer parses the whole body after close, so a truncated stream would lose the receipt.
    let pulled = 0;
    let finished = false;
    const providerBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulled += 1;
        if (pulled <= 3) {
          controller.enqueue(new TextEncoder().encode(`data: chunk-${pulled}\n\n`));
          return;
        }
        finished = true;
        controller.close();
      },
    });
    const background: Promise<unknown>[] = [];
    gatewayReplies = [
      new Response(providerBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', ...admissionHeaders('admitted') },
      }),
    ];
    const response = await handleCaseInference(
      deps({ waitUntil: promise => background.push(promise) }),
      { api: 'chat/completions', request: await request(), db }
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');
    // Read one chunk, then disconnect like a paused runner.
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    // The independent drain must run the provider stream to completion.
    await Promise.all(background);
    expect(finished).toBe(true);
    expect(pulled).toBeGreaterThan(3);
  });

  it('never drains or forwards a refused gateway reply', async () => {
    let pulled = 0;
    const refusedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('{"error":{}}'));
        controller.close();
      },
    });
    gatewayReplies = [
      new Response(refusedBody, {
        status: 402,
        headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
      }),
    ];
    const background: Promise<unknown>[] = [];
    const response = await handleCaseInference(
      deps({ waitUntil: promise => background.push(promise), refusePayer: async () => false }),
      { api: 'chat/completions', request: await request(), db }
    );
    expect(response.status).toBe(402);
    await Promise.all(background);
    // Only the gateway's own single read produced a chunk; nothing else consumed it.
    expect(pulled).toBe(1);
    expect(upstream).toHaveLength(1);
  });
});

describe('trusted case stop marker', () => {
  const STOP = 'x-kilo-benchmark-stop';

  it('marks an infrastructure stop, never a payment verdict, when no payer boundary exists', async () => {
    const response = await handleCaseInference(deps({ resolvePayer: undefined }), {
      api: 'chat/completions',
      request: await request(),
      db,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get(STOP)).toBe('infra_unavailable');
    expect(await response.json()).toMatchObject({ error: { code: 'gateway_jit_unavailable' } });
    expect(upstream).toHaveLength(0);
  });

  it('marks an exhausted payer rotation as no_payer and not as an outage', async () => {
    const response = await handleCaseInference(deps({ resolvePayer: async () => null }), {
      api: 'chat/completions',
      request: await request(),
      db,
    });
    expect(response.status).toBe(402);
    expect(response.headers.get(STOP)).toBe('no_payer');
    expect(upstream).toHaveLength(0);
  });

  it('marks a dead generation as not_live before reading the body', async () => {
    sqlite.prepare("UPDATE benchmark_case_runs SET status = 'settled'").run();
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });
    expect(response.status).toBe(409);
    expect(response.headers.get(STOP)).toBe('not_live');
    expect(upstream).toHaveLength(0);
  });

  it('marks a pre-admission cancellation as cancelled, distinct from a pause or a fund stop', async () => {
    const controller = new AbortController();
    const pending = await request();
    controller.abort();
    const withSignal = new Request(pending.url, {
      method: 'POST',
      headers: pending.headers,
      body: await pending.text(),
      signal: controller.signal,
    });
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: withSignal,
      db,
    });
    expect(response.status).toBe(499);
    expect(response.headers.get(STOP)).toBe('cancelled');
    expect(upstream).toHaveLength(0);
  });

  it('marks a terminally failed model distinctly from a payment refusal', async () => {
    // One payer kind only: the store's permanent-failure fence decides before any selection,
    // and the route must translate it into its own typed stop, never a money verdict.
    let resolves = 0;
    const response = await handleCaseInference(
      deps({
        resolvePayer: async () => {
          resolves += 1;
          return { refused: 'permanently_failed' };
        },
      }),
      { api: 'chat/completions', request: await request(), db }
    );
    expect(response.status).toBe(409);
    expect(response.headers.get(STOP)).toBe('model_permanently_failed');
    expect(await response.json()).toMatchObject({ error: { code: 'permanently_failed' } });
    expect(resolves).toBe(1);
    expect(upstream).toHaveLength(0);
  });

  it('never lets an admitted reply carry the marker, even when the provider echoes it', async () => {
    // A provider that repeats the Worker's header inside an admitted stream: this route copies
    // only the admission and cache headers, so the echo is dropped before it can reach the
    // runner. Defense in depth on top of the runner's own admission-exempt trust rule.
    gatewayReplies = [
      new Response('data: {"text":"done"}\n\n', {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          ...admissionHeaders('admitted'),
          [STOP]: 'no_payer',
        },
      }),
    ];
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-kilo-benchmark-admission')).toBe('admitted');
    expect(response.headers.get(STOP)).toBeNull();
  });

  it('keeps an admitted provider 402 free of any stop after a previous native charge', async () => {
    // The billed call is terminal: a later refusal in the same case is what may stop it, and
    // only the Worker's own marker. This 402 is provider-side and carries no marker.
    gatewayReplies = [
      new Response(JSON.stringify({ error: { code: 'provider_payment_failed' } }), {
        status: 402,
        headers: { 'content-type': 'application/json', ...admissionHeaders('admitted') },
      }),
    ];
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });
    expect(response.status).toBe(402);
    expect(response.headers.get(STOP)).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: 'provider_payment_failed' } });
    expect(upstream).toHaveLength(1);
  });

  it('keeps the Worker and runner stop vocabularies identical', () => {
    expect([...BENCHMARK_CASE_STOP_REASONS]).toEqual([...RUNNER_CASE_STOP_REASONS]);
    expect(BENCHMARK_CASE_STOP_HEADER).toBe(RUNNER_CASE_STOP_HEADER);
  });
});

describe('a reply that never reached admission', () => {
  /**
   * The production defect this guards: a misconfigured admit callback URL made the gateway
   * answer 503 before any permit, with no admission header at all. Treating "not exactly
   * refused" as admitted stored three case results and readied a profile on a case that never
   * reached a provider — only selections, zero usage.
   */
  it('stops a 503 that carries no admission fact instead of grading it', async () => {
    gatewayReplies = [
      new Response(JSON.stringify({ error: { code: 'benchmark_callback_unreachable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    const background: Promise<unknown>[] = [];
    const response = await handleCaseInference(
      deps({ waitUntil: promise => background.push(promise) }),
      { api: 'chat/completions', request: await request(), db }
    );

    expect(response.status).toBe(503);
    // A trusted infrastructure stop, so the runner neither grades nor readies nor replays it.
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('infra_unavailable');
    expect(await response.json()).toMatchObject({ error: { code: 'admission_unknown' } });
    // Nothing was drained: there is no provider stream to finish for an unadmitted reply.
    await Promise.all(background);
    expect(upstream).toHaveLength(1);
  });

  it('stops a 200 that carries no admission fact rather than streaming it as admitted', async () => {
    // The status alone must not decide this: a route that answered 200 without ever calling
    // admit has still not authorized a provider call.
    gatewayReplies = [
      new Response('data: {"text":"not measured"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    ];
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });

    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('infra_unavailable');
    // Our own envelope, not the provider's stream: the case was never measured.
    expect(await response.json()).toMatchObject({ error: { code: 'admission_unknown' } });
  });

  it('never rotates or detaches a payer for a rejected assignment envelope', async () => {
    // The gateway answers 401 for an envelope it cannot authenticate. That proves nothing
    // about the payer, so the route must stop without rotating to another account and
    // without detaching this one — a detach here would blame an innocent payer for a
    // Worker signing bug.
    gatewayReplies = [
      new Response(
        JSON.stringify({
          error: {
            code: 'benchmark_assignment_invalid',
            reason: 'assignment_invalid',
            retryable: false,
          },
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
        }
      ),
    ];
    let resolutions = 0;
    let refusals = 0;
    const response = await handleCaseInference(
      deps({
        resolvePayer: async () => {
          resolutions += 1;
          return PAYER;
        },
        refusePayer: async () => {
          refusals += 1;
          return true;
        },
      }),
      { api: 'chat/completions', request: await request(), db }
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('infra_unavailable');
    expect(await response.json()).toMatchObject({ error: { code: 'assignment_invalid' } });
    // Exactly one attempt, no rotation, and crucially NO detach of the payer.
    expect(resolutions).toBe(1);
    expect(refusals).toBe(0);
    expect(upstream).toHaveLength(1);
  });

  it('does not mistake a 401 assignment refusal for a funding verdict', async () => {
    // A status-only check would read 401 as a credential/payment failure. The typed reason
    // must win: no `no_payer`, no pause of the plan, no charge.
    gatewayReplies = [
      new Response(
        JSON.stringify({
          error: { code: 'benchmark_assignment_invalid', reason: 'assignment_invalid' },
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
        }
      ),
    ];
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });

    expect(response.headers.get('x-kilo-benchmark-stop')).not.toBe('no_payer');
    expect(await response.json()).toMatchObject({ error: { code: 'assignment_invalid' } });
  });

  it('still detaches a payer for a genuine payer_unavailable, unlike a bad envelope', async () => {
    // The contrast that makes the new reason meaningful: a resolvable-but-unbillable payer IS
    // this account's problem, so it still detaches. A rejected envelope never does.
    gatewayReplies = [
      new Response(
        JSON.stringify({ error: { code: 'benchmark_payer_refused', reason: 'payer_unavailable' } }),
        {
          status: 402,
          headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
        }
      ),
      sse(),
    ];
    let refusals = 0;
    let assignments = 0;
    const response = await handleCaseInference(
      deps({
        resolvePayer: async () => {
          assignments += 1;
          return { ...PAYER, assignmentId: `assignment-${assignments}` };
        },
        refusePayer: async () => {
          refusals += 1;
          return true;
        },
      }),
      { api: 'chat/completions', request: await request(), db }
    );

    expect(response.status).toBe(200);
    expect(refusals).toBe(1);
  });

  it('classifies a pre-provider admission_unavailable refusal as infrastructure, not a model outcome', async () => {
    gatewayReplies = [
      new Response(
        JSON.stringify({
          error: { code: 'benchmark_payer_refused', reason: 'admission_unavailable' },
        }),
        {
          status: 503,
          headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
        }
      ),
    ];
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('infra_unavailable');
  });

  it('classifies a closed generation as not live, distinct from a pause or an outage', async () => {
    gatewayReplies = [
      new Response(
        JSON.stringify({ error: { code: 'benchmark_payer_refused', reason: 'generation_closed' } }),
        {
          status: 409,
          headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
        }
      ),
    ];
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });

    expect(response.status).toBe(409);
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('not_live');
  });

  it('stops a lagging receipt as infrastructure without replaying the call', async () => {
    // The gateway reports the payer's earlier permit as unbooked. There is no prior permit in
    // this fixture's store, so nothing can be waited for; the route must still not replay the
    // request — a second forward would open a provider call nobody re-checked.
    gatewayReplies = [
      new Response(
        JSON.stringify({
          error: { code: 'benchmark_payer_refused', reason: 'outstanding_receipt' },
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
        }
      ),
    ];
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });

    expect(upstream).toHaveLength(1);
    expect(response.status).toBe(409);
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('infra_unavailable');
    expect(await response.json()).toMatchObject({ error: { code: 'receipt_unconfirmed' } });
  });

  it('stops immediately for an ambiguous receipt state without retrying', async () => {
    // `receipt_unconfirmed` is not the recoverable "my own earlier permit blocks me" case, so
    // it must never trigger a second dispatch.
    gatewayReplies = [
      new Response(
        JSON.stringify({
          error: { code: 'benchmark_payer_refused', reason: 'receipt_unconfirmed' },
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
        }
      ),
    ];
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });

    expect(upstream).toHaveLength(1);
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('infra_unavailable');
  });

  it('never forwards an unclassifiable refusal body for the runner to interpret', async () => {
    gatewayReplies = [
      new Response(JSON.stringify({ error: { code: 'something_new', reason: 'mystery' } }), {
        status: 500,
        headers: { 'content-type': 'application/json', ...admissionHeaders('refused') },
      }),
    ];
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });

    // Our own trusted stop, and our own envelope — never the gateway's reason text.
    expect(response.headers.get('x-kilo-benchmark-stop')).toBe('infra_unavailable');
    expect(await response.json()).toMatchObject({ error: { code: 'admission_unknown' } });
  });

  it('still streams and charges an admitted provider 4xx', async () => {
    // The distinction that must survive: once the gateway says `admitted`, a provider error is
    // a real measured outcome with possible usage, so it is forwarded untouched and unbilled
    // reclassification never happens.
    gatewayReplies = [
      new Response(JSON.stringify({ error: { code: 'provider_bad_request' } }), {
        status: 400,
        headers: { 'content-type': 'application/json', ...admissionHeaders('admitted') },
      }),
    ];
    const response = await handleCaseInference(deps(), {
      api: 'chat/completions',
      request: await request(),
      db,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('x-kilo-benchmark-stop')).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: 'provider_bad_request' } });
  });
});
