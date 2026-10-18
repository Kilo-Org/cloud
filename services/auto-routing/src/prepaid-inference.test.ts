import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { admitClassifierInference } from './prepaid-inference';

const fetchMock = vi.fn<typeof fetch>();
const requestId = '00000000-0000-4000-8000-000000000001';
const env = {
  KILO_WEB_API_BASE_URL: 'https://web.example.test',
  INTERNAL_API_SECRET_PROD: { get: async () => 'test-secret' },
};
const input = {
  requestId,
  userId: 'user-1',
  organizationId: null,
  model: 'typesafe/jev-1.13',
  body: { model: 'typesafe/jev-1.13', state: {}, questions: {} },
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('classifier prepaid admission', () => {
  it('rejects worker-enabled admission when web enforcement did not reserve credits', async () => {
    fetchMock.mockResolvedValue(Response.json({ kind: 'admitted', body: input.body }));
    await expect(admitClassifierInference(env, input)).rejects.toBeInstanceOf(Error);
  });

  it.each([402, 503])('rejects provider dispatch after admission status %s', async status => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(admitClassifierInference(env, input)).rejects.toBeInstanceOf(Error);
  });

  it('rejects a reservation for a different usage identity', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        kind: 'admitted',
        reservationId: '00000000-0000-4000-8000-000000000002',
        body: input.body,
      })
    );
    await expect(admitClassifierInference(env, input)).rejects.toBeInstanceOf(Error);
  });
});
