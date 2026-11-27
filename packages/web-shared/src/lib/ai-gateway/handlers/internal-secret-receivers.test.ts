// Do not import `jest` from '@jest/globals': the SWC transform hoists these `jest.mock` calls only
// with the global `jest`.
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'env-only-secret',
  AUTO_ROUTING_BENCHMARK_WORKER_URL: 'https://benchmark.example.com',
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy', () => ({
  handleLlmProxyRequest: jest.fn(async () => new Response('{}', { status: 200 })),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-denied-models', () => ({
  deniedAutoRoutingModelIdsForMember: jest.fn(),
}));

import {
  BENCHMARK_ASSIGNMENT_HEADER,
  BENCHMARK_GATEWAY_ASSIGNMENT_SCOPE,
  benchmarkGatewayAssignmentParts,
  benchmarkProjectId,
  type BenchmarkGatewayAssignment,
} from '@kilocode/auto-routing-contracts';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';
import { NextRequest } from 'next/server';
import { handleLlmProxyRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy';
import { installInternalApiSecretRead } from '@kilocode/web-shared/lib/internal-api-secret';
import { handleAutoRoutingDeniedModelsRequest } from './auto-routing-denied-models';
import { handleBenchmarkCaseInference } from './benchmark-case-inference';

// The gateway's internal receivers check the secret the app's installed read selects. Nothing
// installed keeps the configured value. A failed read is a retryable unavailable answer, not a
// credential refusal, with no proxy call, no log and no error text in the response.

const ENV_SECRET = 'env-only-secret';
const DELIVERED = 'sts-delivered-secret';
const READ_ERROR = 'STS denied the bundle request for this workload';
const installedRead = jest.fn<Promise<string>, []>();
const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map(method =>
  jest.spyOn(console, method)
);

function assignment(): BenchmarkGatewayAssignment {
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
    projectId: benchmarkProjectId({
      scope: 'user',
      slug: 'my-pool',
      routerId: '6f1c2f3a-1111-4a2b-8c3d-4e5f60718293',
    }),
  };
}

async function caseInferenceRequest(signingSecret: string): Promise<Request> {
  const value = assignment();
  const token = await deriveCallbackToken({
    secret: signingSecret,
    scope: BENCHMARK_GATEWAY_ASSIGNMENT_SCOPE,
    resourceParts: benchmarkGatewayAssignmentParts(value),
  });
  return new Request('https://ai-gateway.test/api/v1/internal/benchmark/case-inference', {
    method: 'POST',
    headers: {
      [BENCHMARK_ASSIGNMENT_HEADER]: Buffer.from(JSON.stringify(value)).toString('base64url'),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      api: 'chat/completions',
      request: { model: value.model, messages: [{ role: 'user', content: 'hi' }] },
    }),
  });
}

async function caseInference(signingSecret: string): Promise<Response> {
  return handleBenchmarkCaseInference(await caseInferenceRequest(signingSecret));
}

const INVALID_ASSIGNMENT = {
  error: { code: 'benchmark_assignment_invalid', reason: 'assignment_invalid', retryable: false },
};

function deniedModels(authorization?: string): Promise<Response> {
  return handleAutoRoutingDeniedModelsRequest(
    new NextRequest('https://ai-gateway.test/api/v1/internal/auto-routing/denied-models', {
      method: 'POST',
      headers: authorization === undefined ? {} : { authorization },
      // Invalid on purpose: a 400 proves the credential passed without a policy lookup.
      body: '{}',
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SECRETS_SOURCE;
  installedRead.mockResolvedValue(DELIVERED);
  globalThis.__kilocodeInternalApiSecretRead = undefined;
});

afterEach(() => {
  delete process.env.SECRETS_SOURCE;
  globalThis.__kilocodeInternalApiSecretRead = undefined;
});

describe.each([
  ['nothing installed and an unrelated SECRETS_SOURCE', false, ENV_SECRET, DELIVERED],
  ['the installed read', true, DELIVERED, ENV_SECRET],
])('with %s', (_name, installed, accepted, refused) => {
  beforeEach(() => {
    if (installed) installInternalApiSecretRead(installedRead);
    else process.env.SECRETS_SOURCE = 'sts';
  });

  it('denied-models accepts only the selected bearer', async () => {
    const admitted = await deniedModels(`Bearer ${accepted}`);
    expect(admitted.status).toBe(400);
    expect(await admitted.json()).toEqual({ error: 'Invalid request' });
    const rejected = await deniedModels(`Bearer ${refused}`);
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({ error: 'Unauthorized' });
  });

  it('case inference verifies the assignment only with the selected secret', async () => {
    const rejected = await caseInference(refused);
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual(INVALID_ASSIGNMENT);
    expect(handleLlmProxyRequest).not.toHaveBeenCalled();

    await caseInference(accepted);
    expect(handleLlmProxyRequest).toHaveBeenCalledTimes(1);
  });
});

describe('when the installed read fails', () => {
  beforeEach(() => {
    installInternalApiSecretRead(installedRead);
    installedRead.mockRejectedValue(new Error(READ_ERROR));
  });

  afterEach(() => {
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('denied-models answers a generic 503, not a credential refusal', async () => {
    const response = await deniedModels(`Bearer ${DELIVERED}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Unavailable' });
  });

  it('case inference refuses as retryable admission_unavailable before the body or proxy', async () => {
    const request = await caseInferenceRequest(DELIVERED);
    const response = await handleBenchmarkCaseInference(request);
    expect(response.status).toBe(503);
    expect(response.headers.get('x-kilo-benchmark-admission')).toBe('refused');
    expect(await response.json()).toEqual({
      error: {
        code: 'benchmark_payer_refused',
        reason: 'admission_unavailable',
        retryable: true,
      },
    });
    expect(request.bodyUsed).toBe(false);
    expect(handleLlmProxyRequest).not.toHaveBeenCalled();
  });
});

it('denied-models refuses a request without a bearer before reading the secret', async () => {
  installInternalApiSecretRead(installedRead);
  const response = await deniedModels();
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'Unauthorized' });
  expect(installedRead).not.toHaveBeenCalled();
});

it('denied-models refuses every bearer for an empty delivered secret', async () => {
  installInternalApiSecretRead(installedRead);
  installedRead.mockResolvedValue('');
  const response = await deniedModels(`Bearer ${DELIVERED}`);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'Unauthorized' });
});

it('case inference keeps its not-configured answer for an empty delivered secret', async () => {
  installInternalApiSecretRead(installedRead);
  installedRead.mockResolvedValue('');
  const response = await caseInference(DELIVERED);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: 'not_configured' } });
  expect(handleLlmProxyRequest).not.toHaveBeenCalled();
});
