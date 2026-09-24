jest.mock('@/lib/config.server', () => ({ INTERNAL_API_SECRET: 'test-internal-secret' }));
jest.mock('@/lib/dotenvx', () => ({
  getEnvVariable: () => 'https://cloud-agent.example.test',
}));

import { getE2BComputeEnrollment } from './cloud-agent-client';

const organizationId = 'aabbccdd-1111-4111-8111-111111111111';
const privateDetail = 'private-provider-detail-test-internal-secret';
let fetchMock: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(privateDetail));
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function expectSafeFailure(result: Promise<unknown>) {
  const error: unknown = await result.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('Expected an Error');
  expect(error.message).toBe('Cloud Agent E2B compute enrollment could not be verified');
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(privateDetail);
  expect(error.message).not.toContain('test-internal-secret');
}

it.each([true, false])('returns the authenticated Worker enrollment value %s', async enrolled => {
  fetchMock.mockResolvedValueOnce(Response.json({ enrolled, ignored: privateDetail }));
  const timeout = jest.spyOn(AbortSignal, 'timeout');

  await expect(
    getE2BComputeEnrollment({ organizationId: organizationId.toUpperCase() })
  ).resolves.toEqual({ enrolled });
  expect(timeout).toHaveBeenCalledWith(10_000);
  expect(fetchMock).toHaveBeenCalledWith(
    `https://cloud-agent.example.test/internal/byoc/e2b-enrollment/${organizationId}`,
    {
      headers: { Accept: 'application/json', 'x-internal-api-key': 'test-internal-secret' },
      cache: 'no-store',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }
  );
});

it.each([null, {}, { enrolled: 'true' }, { enrolled: 1 }])(
  'fails closed on a malformed Worker response',
  async body => {
    fetchMock.mockResolvedValueOnce(Response.json(body));
    await expectSafeFailure(getE2BComputeEnrollment({ organizationId }));
  }
);

it('rejects malformed organization IDs without a request', async () => {
  await expectSafeFailure(getE2BComputeEnrollment({ organizationId: 'organization/other' }));
  expect(fetchMock).not.toHaveBeenCalled();
});

it('sanitizes upstream HTTP and transport errors', async () => {
  await expectSafeFailure(getE2BComputeEnrollment({ organizationId }));
  const response = new Response(privateDetail, { status: 503 });
  fetchMock.mockResolvedValueOnce(response);
  await expectSafeFailure(getE2BComputeEnrollment({ organizationId }));
  expect(response.bodyUsed).toBe(false);
});

it('rejects redirect responses and malformed JSON without retaining response data', async () => {
  const response = Response.json({ enrolled: true });
  Object.defineProperty(response, 'redirected', { value: true });
  fetchMock.mockResolvedValueOnce(response);
  await expectSafeFailure(getE2BComputeEnrollment({ organizationId }));
  fetchMock.mockResolvedValueOnce(new Response(privateDetail));
  await expectSafeFailure(getE2BComputeEnrollment({ organizationId }));
});
