import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  BENCHMARK_ADMISSION_HEADER,
  BENCHMARK_ASSIGNMENT_HEADER,
  BENCHMARK_GATEWAY_ASSIGNMENT_SCOPE,
  BENCHMARK_PLATFORM_PROJECT_ID,
  BENCHMARK_USAGE_ID_HEADER,
  benchmarkGatewayAssignmentParts,
  benchmarkProjectId,
  type BenchmarkGatewayAssignment,
} from '@kilocode/auto-routing-contracts';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';

const mockFetch = jest.fn<typeof fetch>();
let mockWorkerUrl = 'https://benchmark.internal';
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get AUTO_ROUTING_BENCHMARK_WORKER_URL() {
    return mockWorkerUrl;
  },
}));

import {
  BENCHMARK_ASSIGNMENT_TTL_MS,
  benchmarkRefusalResponse,
  requestBenchmarkAdmission,
  signedModelViolation,
  verifyBenchmarkAssignment,
} from './benchmark-case-admission';

const SECRET = 'test-internal-secret';
const ROUTER_ID = '6f1c2f3a-1111-4a2b-8c3d-4e5f60718293';

function assignment(
  overrides: Partial<BenchmarkGatewayAssignment> = {}
): BenchmarkGatewayAssignment {
  return {
    engineIdentity: 'engine-1',
    runId: 'run-1',
    model: 'openai/gpt-4o',
    variant: '',
    caseId: 'case-1',
    repetition: 0,
    generation: 3,
    startedAt: Date.now(),
    api: 'chat/completions',
    modelRequestId: '11111111-1111-4111-8111-111111111111',
    assignmentId: '22222222-2222-4222-8222-222222222222',
    requestId: '33333333-3333-4333-8333-333333333333',
    usageId: '44444444-4444-4444-8444-444444444444',
    payer: { type: 'user', id: 'user-1' },
    actorUserId: 'user-1',
    executorUserId: 'bot-internal-benchmark',
    platformOrganizationId: null,
    projectId: benchmarkProjectId({ scope: 'user', slug: 'my-pool', routerId: ROUTER_ID }),
    ...overrides,
  };
}

async function signedHeaders(value: BenchmarkGatewayAssignment, secret = SECRET): Promise<Headers> {
  const token = await deriveCallbackToken({
    secret,
    scope: BENCHMARK_GATEWAY_ASSIGNMENT_SCOPE,
    resourceParts: benchmarkGatewayAssignmentParts(value),
  });
  return new Headers({
    [BENCHMARK_ASSIGNMENT_HEADER]: Buffer.from(JSON.stringify(value)).toString('base64url'),
    authorization: `Bearer ${token}`,
  });
}

describe('verifyBenchmarkAssignment', () => {
  it('accepts a correctly signed assignment', async () => {
    const value = assignment();
    const result = await verifyBenchmarkAssignment(await signedHeaders(value), SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assignment).toEqual(value);
  });

  it('rejects a tampered payer (the signature covers it)', async () => {
    const value = assignment();
    const headers = await signedHeaders(value);
    const tampered = { ...value, payer: { type: 'organization', id: 'org-9' } };
    headers.set(
      BENCHMARK_ASSIGNMENT_HEADER,
      Buffer.from(JSON.stringify(tampered)).toString('base64url')
    );
    const result = await verifyBenchmarkAssignment(headers, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(402);
  });

  it('rejects a wrong secret, a stale token, and a missing header', async () => {
    const value = assignment();
    expect((await verifyBenchmarkAssignment(await signedHeaders(value, 'other'), SECRET)).ok).toBe(
      false
    );
    const stale = assignment({ startedAt: Date.now() - BENCHMARK_ASSIGNMENT_TTL_MS - 1 });
    expect((await verifyBenchmarkAssignment(await signedHeaders(stale), SECRET)).ok).toBe(false);
    expect((await verifyBenchmarkAssignment(new Headers(), SECRET)).ok).toBe(false);
  });

  it('rejects a platform project on a paid assignment and vice versa', async () => {
    // Paid with the platform project id: schema refinement refuses it.
    const badPaid = { ...assignment(), projectId: BENCHMARK_PLATFORM_PROJECT_ID };
    const badHeaders = new Headers({
      [BENCHMARK_ASSIGNMENT_HEADER]: Buffer.from(JSON.stringify(badPaid)).toString('base64url'),
      authorization: 'Bearer whatever',
    });
    expect((await verifyBenchmarkAssignment(badHeaders, SECRET)).ok).toBe(false);

    const platform = assignment({
      payer: null,
      requestId: null,
      projectId: BENCHMARK_PLATFORM_PROJECT_ID,
      platformOrganizationId: '7a1c2f3a-1111-4a2b-8c3d-4e5f60718293',
    });
    expect((await verifyBenchmarkAssignment(await signedHeaders(platform), SECRET)).ok).toBe(true);

    // Platform payer with a user project id is refused.
    const badPlatform = assignment({
      payer: null,
      requestId: null,
      projectId: benchmarkProjectId({ scope: 'user', slug: 'p', routerId: ROUTER_ID }),
      platformOrganizationId: '7a1c2f3a-1111-4a2b-8c3d-4e5f60718293',
    });
    expect((await verifyBenchmarkAssignment(await signedHeaders(badPlatform), SECRET)).ok).toBe(
      false
    );
  });
});

/**
 * The Worker's admit boundary as the gateway meets it: an unauthenticated caller gets 401 and
 * no permit. `permit` counts only the `phase: 'admit'` calls that passed the Bearer check, so
 * tests assert the outcome rather than a header string.
 */
function admitWorker(secret: string) {
  let permits = 0;
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const authorization = new Headers(init?.headers).get('authorization');
    if (authorization !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 });
    }
    if (typeof init?.body !== 'string') return new Response('no body', { status: 400 });
    const body = JSON.parse(init.body) as { phase?: string };
    if (body.phase !== 'admit') return new Response('not an admit', { status: 400 });
    permits += 1;
    return new Response(JSON.stringify({ decision: 'admit' }), { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchImpl, permit: () => permits, calls: () => calls };
}

describe('requestBenchmarkAdmission', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockWorkerUrl = 'https://benchmark.internal';
  });

  it('sends the configured secret as a Bearer and is admitted by the Worker boundary', async () => {
    const worker = admitWorker(SECRET);
    const refusal = await requestBenchmarkAdmission(assignment(), {
      secret: SECRET,
      fetchImpl: worker.fetch,
      workerUrl: mockWorkerUrl,
    });
    expect(refusal).toBeNull();
    expect(worker.calls()).toBe(1);
    expect(worker.permit()).toBe(1);
  });

  it('never reaches a permit when the callback secret does not match the Worker', async () => {
    const worker = admitWorker(SECRET);
    const refusal = await requestBenchmarkAdmission(assignment(), {
      secret: 'wrong-secret',
      fetchImpl: worker.fetch,
      workerUrl: mockWorkerUrl,
    });
    expect(worker.permit()).toBe(0);
    expect(refusal).toEqual({ reason: 'admission_unavailable', retryable: true });
  });

  it('refuses to send an unauthenticated callback at all', async () => {
    const worker = admitWorker(SECRET);
    const refusal = await requestBenchmarkAdmission(assignment(), {
      secret: '',
      fetchImpl: worker.fetch,
      workerUrl: mockWorkerUrl,
    });
    expect(refusal).toEqual({ reason: 'admission_unavailable', retryable: true });
    expect(worker.calls()).toBe(0);
    expect(worker.permit()).toBe(0);
  });

  it('posts the assignment to the admit path with the Bearer header', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ decision: 'admit' }), { status: 200 })
    );
    await requestBenchmarkAdmission(assignment(), {
      secret: SECRET,
      fetchImpl: mockFetch,
      workerUrl: mockWorkerUrl,
    });
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toEqual('https://benchmark.internal/internal/case-admit');
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${SECRET}` });
    expect((init as RequestInit).headers).not.toHaveProperty('x-internal-api-key');
  });

  it('maps a trusted refusal and keeps its retryable flag', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ decision: 'refuse', reason: 'payer_changed', retryable: true }),
        { status: 200 }
      )
    );
    const refusal = await requestBenchmarkAdmission(assignment(), {
      secret: SECRET,
      fetchImpl: mockFetch,
      workerUrl: mockWorkerUrl,
    });
    expect(refusal).toEqual({ reason: 'payer_changed', retryable: true });
  });

  it('treats an unreachable or malformed callback as admission_unavailable', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    expect(
      await requestBenchmarkAdmission(assignment(), { secret: SECRET, fetchImpl: mockFetch })
    ).toEqual({ reason: 'admission_unavailable', retryable: true });

    mockFetch.mockResolvedValue(new Response('not json', { status: 500 }));
    expect(
      await requestBenchmarkAdmission(assignment(), { secret: SECRET, fetchImpl: mockFetch })
    ).toEqual({ reason: 'admission_unavailable', retryable: true });
  });
});

describe('signedModelViolation', () => {
  it('accepts the exact concrete model only', () => {
    const value = assignment();
    expect(signedModelViolation(value, 'openai/gpt-4o')).toBe(false);
    expect(signedModelViolation(value, 'openai/gpt-4o-mini')).toBe(true);
    expect(signedModelViolation(value, 'kilo-auto/balanced')).toBe(true);
    expect(signedModelViolation(value, '~openai/gpt-4o-latest')).toBe(true);
  });
});

describe('refusal header', () => {
  it('marks every refusal as such and never as admitted', () => {
    for (const reason of ['payment_refused', 'payer_changed', 'admission_unavailable'] as const) {
      const response = benchmarkRefusalResponse(reason, true);
      expect(response.headers.get(BENCHMARK_ADMISSION_HEADER)).toBe('refused');
      expect(response.headers.get(BENCHMARK_USAGE_ID_HEADER)).toBeNull();
    }
  });
});
