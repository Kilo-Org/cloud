import { describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_READ_TIMEOUT_MS,
  readAnalysisCreditAdmission,
  type AnalysisCreditAdmission,
} from './credit-admission.js';

const AUTH_TOKEN = 'control-token';
const ORGANIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMISSION_URL_PREFIX = 'https://cloud-agent-next/trpc/getAnalysisCreditAdmission?input=';

function createEnv(respond: (request: Request) => Promise<Response>) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (request: Request) => {
    requests.push(request);
    return respond(request);
  });
  return { env: { CLOUD_AGENT_NEXT: { fetch } } as unknown as CloudflareEnv, requests };
}

function admissionResponse(data: unknown) {
  return Response.json({ result: { data } });
}

function singleRequest(requests: Request[]): Request {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (request === undefined) throw new Error('Expected exactly one Cloud Agent request');
  return request;
}

function readInput(url: string): unknown {
  const input = new URL(url).searchParams.get('input');
  if (input === null) throw new Error('Expected an input query parameter');
  return JSON.parse(input);
}

function unavailableMessage(result: AnalysisCreditAdmission): string {
  if (result.outcome !== 'unavailable') {
    throw new Error(`Expected an unavailable decision, received ${result.outcome}`);
  }
  return result.message;
}

// A peer that accepts the request and never answers: the promise only settles
// when the request's own deadline aborts the signal. The request is retained
// here because its abort listener lives with the request's signal, so a request
// reachable only from a promise that never settles may be collected before the
// deadline fires.
const IN_FLIGHT_REQUESTS: Request[] = [];

function answerOnlyOnAbort(request: Request, onAbort?: () => void): Promise<Response> {
  IN_FLIGHT_REQUESTS.push(request);
  const { promise, reject } = Promise.withResolvers<Response>();
  request.signal.addEventListener(
    'abort',
    () => {
      onAbort?.();
      reject(request.signal.reason);
    },
    { once: true }
  );
  return promise;
}

const PEER_RESPONSES: Array<() => Promise<Response>> = [
  async () => new Response('Unauthorized', { status: 401 }),
  async () => new Response('Not Found', { status: 404 }),
  async () => new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
  async () => admissionResponse({ outcome: 'maybe' }),
  async () => {
    throw new Error('network failure');
  },
];

describe('readAnalysisCreditAdmission request', () => {
  it('builds a GET request with the bearer header and no body for a user payer', async () => {
    const { env, requests } = createEnv(async () => admissionResponse({ outcome: 'admitted' }));

    await readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN });

    const request = singleRequest(requests);
    expect(request.method).toBe('GET');
    expect(request.url.startsWith(ADMISSION_URL_PREFIX)).toBe(true);
    expect(readInput(request.url)).toEqual({});
    expect(request.headers.get('Authorization')).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(request.headers.get('content-type')).toBeNull();
    expect(request.body).toBeNull();
    expect(await request.text()).toBe('');
  });

  it('encodes the organization id in the input query parameter', async () => {
    const { env, requests } = createEnv(async () => admissionResponse({ outcome: 'admitted' }));

    await readAnalysisCreditAdmission({
      env,
      authToken: AUTH_TOKEN,
      organizationId: ORGANIZATION_ID,
    });

    const request = singleRequest(requests);
    expect(request.method).toBe('GET');
    expect(readInput(request.url)).toEqual({ organizationId: ORGANIZATION_ID });
    expect(request.url).toBe(
      `${ADMISSION_URL_PREFIX}${encodeURIComponent(
        JSON.stringify({ organizationId: ORGANIZATION_ID })
      )}`
    );
    expect(request.headers.get('Authorization')).toBe(`Bearer ${AUTH_TOKEN}`);
  });

  it('carries an abort signal for both payer kinds', async () => {
    for (const organizationId of [undefined, ORGANIZATION_ID]) {
      const { env, requests } = createEnv(async () => admissionResponse({ outcome: 'admitted' }));

      await readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN, organizationId });

      expect(singleRequest(requests).signal).toBeInstanceOf(AbortSignal);
    }
  });
});

describe('readAnalysisCreditAdmission answer mapping', () => {
  it('returns the first answer unchanged', async () => {
    const { env } = createEnv(async () => admissionResponse({ outcome: 'admitted' }));

    await expect(readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN })).resolves.toEqual({
      outcome: 'admitted',
    });
  });

  it('returns the second answer unchanged', async () => {
    const decision = { outcome: 'insufficient_credits', message: 'Insufficient credits' };
    const { env } = createEnv(async () => admissionResponse(decision));

    await expect(readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN })).resolves.toEqual(
      decision
    );
  });

  it('returns the third answer unchanged', async () => {
    const decision = { outcome: 'unavailable', message: 'Failed to verify balance' };
    const { env } = createEnv(async () => admissionResponse(decision));

    expect(await readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN })).toEqual(decision);
  });
});

describe('readAnalysisCreditAdmission unreadable answers', () => {
  it('reports a rejected response without the status in the message', async () => {
    const { env } = createEnv(async () => new Response('Not Found', { status: 404 }));

    const result = await readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN });

    expect(unavailableMessage(result)).toBe('Cloud Agent credit admission was not accepted');
  });

  it('reports a 403 answer as a permanent refusal', async () => {
    const { env } = createEnv(async () => new Response('refused', { status: 403 }));

    const result = await readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN });

    expect(result).toEqual({
      outcome: 'refused',
      message: 'Cloud Agent credit admission was refused',
    });
    if (result.outcome !== 'refused') throw new Error('Expected a refused admission');
    expect(result.message).not.toMatch(/\d/);
    expect(result.message).not.toContain(AUTH_TOKEN);
  });

  it('reports every other non-OK status, including 401, as one retryable message', async () => {
    // A 401 is left unreadable with the other non-OK answers: the peer's
    // credential verdict can change with its deployment.
    const statuses = [401, 404, 429, 500, 503];

    for (const status of statuses) {
      const { env } = createEnv(async () => new Response('refused', { status }));

      const message = unavailableMessage(
        await readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN })
      );

      expect(message).toBe('Cloud Agent credit admission was not accepted');
      expect(message).not.toMatch(/\d/);
      expect(message).not.toContain(AUTH_TOKEN);
    }
  });

  it('reports a non-JSON body', async () => {
    const { env } = createEnv(
      async () =>
        new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })
    );

    const result = await readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN });

    expect(result).toEqual({ outcome: 'unavailable', message: expect.any(String) });
  });

  it('reports a body outside the schema', async () => {
    const { env } = createEnv(async () => admissionResponse({ outcome: 'maybe' }));

    const result = await readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN });

    expect(result).toEqual({ outcome: 'unavailable', message: expect.any(String) });
  });

  it('reports a rejected fetch without throwing', async () => {
    const { env } = createEnv(async () => {
      throw new Error('network failure');
    });

    await expect(readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN })).resolves.toEqual({
      outcome: 'unavailable',
      message: expect.any(String),
    });
  });

  it('reports one contract message per unreadable answer', async () => {
    const messages: string[] = [];
    for (const respond of PEER_RESPONSES) {
      const { env } = createEnv(respond);
      const result = await readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN });
      messages.push(unavailableMessage(result));
    }

    expect(messages).toHaveLength(PEER_RESPONSES.length);
    expect(messages.join('\n')).not.toContain(AUTH_TOKEN);
  });
});

describe('readAnalysisCreditAdmission deadline', () => {
  it('bounds the read at ten seconds unless a test passes a shorter bound', () => {
    expect(ADMISSION_READ_TIMEOUT_MS).toBe(10_000);
  });

  it('ends the read when a peer that never answers hits the admission deadline', async () => {
    let aborted = false;
    const { env, requests } = createEnv(async request =>
      answerOnlyOnAbort(request, () => {
        aborted = true;
      })
    );

    const startedAt = Date.now();
    const result = await readAnalysisCreditAdmission({
      env,
      authToken: AUTH_TOKEN,
      timeoutMs: 20,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2000);
    expect(aborted).toBe(true);
    expect(unavailableMessage(result)).toBe('Cloud Agent credit admission request failed');
    expect(singleRequest(requests).signal.aborted).toBe(true);
  });
});
