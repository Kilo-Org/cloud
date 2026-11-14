import { describe, expect, it, vi } from 'vitest';
import { readAnalysisCreditAdmission, type AnalysisCreditAdmission } from './credit-admission.js';

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

const PEER_RESPONSES: Array<() => Promise<Response>> = [
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
  it('reports the status when the peer answers 404', async () => {
    const { env } = createEnv(async () => new Response('Not Found', { status: 404 }));

    const result = await readAnalysisCreditAdmission({ env, authToken: AUTH_TOKEN });

    expect(unavailableMessage(result)).toContain('404');
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