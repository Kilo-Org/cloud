import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type * as BalanceValidationModule from '../../balance-validation.js';
import type { Env } from '../../types.js';

const { validateBalanceOnly } = vi.hoisted(() => ({ validateBalanceOnly: vi.fn() }));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
}));

// The worker's bearer check reads the account pepper row before the procedure runs.
vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ api_token_pepper: null, blocked_reason: null }],
        }),
      }),
    }),
  }),
}));

vi.mock('../../balance-validation.js', async importOriginal => ({
  ...(await importOriginal<typeof BalanceValidationModule>()),
  validateBalanceOnly,
}));

import worker from '../../server.js';

const SECRET = 'transport-test-secret';
const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const ENDPOINT = 'https://worker.test/trpc/getAnalysisCreditAdmission';

const TOKEN = jwt.sign({ version: 3, kiloUserId: 'usr_transport' }, SECRET, {
  algorithm: 'HS256',
});

const env = {
  NEXTAUTH_SECRET: SECRET,
  HYPERDRIVE: { connectionString: 'postgres://transport-test' },
  KILOCODE_BACKEND_BASE_URL: 'https://backend.test',
} as unknown as Env;

function fetchWorker(request: Request): Promise<Response> | Response {
  return worker.fetch(request, env, {} as ExecutionContext);
}

function getRequest(input?: unknown): Request {
  const url = new URL(ENDPOINT);
  if (input !== undefined) url.searchParams.set('input', JSON.stringify(input));
  return new Request(url, { headers: { authorization: `Bearer ${TOKEN}` } });
}

function postRequest(input: unknown): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
}

describe('getAnalysisCreditAdmission over the worker transport', () => {
  beforeEach(() => {
    validateBalanceOnly.mockReset();
  });

  it('answers a GET with ?input={} and admits when the balance check succeeds', async () => {
    validateBalanceOnly.mockResolvedValue({ success: true });

    const response = await fetchWorker(getRequest({}));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { data?: { outcome?: string } } };
    expect(body.result?.data?.outcome).toBe('admitted');
  });

  it('forwards the organization id encoded in the GET input', async () => {
    validateBalanceOnly.mockResolvedValue({ success: true });

    const response = await fetchWorker(getRequest({ organizationId: ORGANIZATION_ID }));

    expect(response.status).toBe(200);
    expect(validateBalanceOnly).toHaveBeenCalledWith(TOKEN, ORGANIZATION_ID, env);
  });

  it('refuses a POST because the procedure is a query', async () => {
    validateBalanceOnly.mockResolvedValue({ success: true });

    const response = await fetchWorker(postRequest({}));

    expect(response.ok).toBe(false);
    expect(response.status).toBe(405);
    const body = (await response.json()) as {
      error?: { message?: string; data?: { code?: string; httpStatus?: number } };
    };
    expect(body.error?.message).toBe(
      'Unsupported POST-request to query procedure at path "getAnalysisCreditAdmission"'
    );
    expect(body.error?.data).toMatchObject({ code: 'METHOD_NOT_SUPPORTED', httpStatus: 405 });
    expect(validateBalanceOnly).not.toHaveBeenCalled();
  });

  it('answers an unavailable balance read with the unavailable outcome', async () => {
    validateBalanceOnly.mockResolvedValue({
      success: false,
      status: 500,
      message: 'Failed to verify balance',
    });

    const response = await fetchWorker(getRequest({}));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { data?: { outcome?: string; message?: string } };
    };
    expect(body.result?.data).toEqual({
      outcome: 'unavailable',
      message: 'Failed to verify balance',
    });
  });
});
