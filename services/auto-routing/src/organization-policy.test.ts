import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOrganizationPolicyCache, deniedOrganizationModelIds } from './organization-policy';

const fetchMock = vi.fn<typeof fetch>();

const env = {
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
  KILO_AI_GATEWAY_BASE_URL: 'https://gateway.example.test',
} as unknown as Env;

const request = {
  organizationId: 'org-1',
  userId: 'user-1',
  modelIds: ['anthropic/claude-sonnet-4.6'],
};

function deniedModelIdsAnswer(deniedModelIds: string[]): Response {
  return Response.json({ deniedModelIds });
}

beforeEach(() => {
  clearOrganizationPolicyCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('organization policy cache', () => {
  it('keeps the answer the later lookup produced when an earlier one finishes last', async () => {
    const earlier = Promise.withResolvers<Response>();
    fetchMock.mockImplementationOnce(() => earlier.promise);
    fetchMock.mockImplementationOnce(async () => deniedModelIdsAnswer(['openai/newer']));

    const slow = deniedOrganizationModelIds(env, request);
    expect(await deniedOrganizationModelIds(env, request)).toEqual(['openai/newer']);
    earlier.resolve(deniedModelIdsAnswer(['openai/older']));
    expect(await slow).toEqual(['openai/older']);

    // The cached answer is the one the later lookup produced, and it is served without a lookup.
    expect(await deniedOrganizationModelIds(env, request)).toEqual(['openai/newer']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expires the cached answer from when the lookup started, not from when it finished', async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const held = Promise.withResolvers<Response>();
    fetchMock.mockImplementationOnce(() => held.promise);
    fetchMock.mockImplementationOnce(async () => deniedModelIdsAnswer([]));

    const slow = deniedOrganizationModelIds(env, request);
    // The gateway answers 59 s after the lookup started, so a finish-based TTL would hold the answer
    // for another 60 s from here.
    clock += 59_000;
    held.resolve(deniedModelIdsAnswer(['openai/denied']));
    expect(await slow).toEqual(['openai/denied']);

    clock += 2_000;
    expect(await deniedOrganizationModelIds(env, request)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
