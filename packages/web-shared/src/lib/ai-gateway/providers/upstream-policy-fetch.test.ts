import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { upstreamDispatcherFor } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-connection';
import {
  findUpstreamUrlViolation,
  isUpstreamUrlPolicyEnforced,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy';
import { fetchWithUpstreamUrlPolicy, UpstreamUrlPolicyError } from './upstream-policy-fetch';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy', () => ({
  isUpstreamUrlPolicyEnforced: jest.fn(),
  findUpstreamUrlViolation: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/upstream-connection', () => ({
  upstreamDispatcherFor: jest.fn(() => 'pinned-dispatcher'),
}));

const MODELS_URL = 'https://llm.example.com/v1/models';
let fetchSpy: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isUpstreamUrlPolicyEnforced).mockReturnValue(true);
  jest.mocked(findUpstreamUrlViolation).mockResolvedValue({
    allowed: true,
    hostname: 'llm.example.com',
    addresses: ['203.0.113.7'],
    expiresAt: 1,
  });
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
});

afterEach(() => fetchSpy.mockRestore());

describe('fetchWithUpstreamUrlPolicy', () => {
  test('connects to the checked addresses and refuses redirects', async () => {
    await fetchWithUpstreamUrlPolicy(MODELS_URL, { method: 'GET' });

    expect(upstreamDispatcherFor).toHaveBeenCalledWith('llm.example.com', ['203.0.113.7'], 1);
    expect(fetchSpy).toHaveBeenCalledWith(MODELS_URL, {
      method: 'GET',
      redirect: 'manual',
      dispatcher: 'pinned-dispatcher',
    });
  });

  test('never dials a URL the policy refuses', async () => {
    jest
      .mocked(findUpstreamUrlViolation)
      .mockResolvedValue({ allowed: false, violation: 'non_public_address' });

    await expect(fetchWithUpstreamUrlPolicy(MODELS_URL)).rejects.toEqual(
      new UpstreamUrlPolicyError('non_public_address')
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('throws on a redirect instead of following it', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, { status: 307, headers: { location: 'http://10.0.0.1/' } })
    );

    await expect(fetchWithUpstreamUrlPolicy(MODELS_URL)).rejects.toEqual(
      new UpstreamUrlPolicyError('redirect')
    );
  });

  test('skips the check where the policy is not enforced', async () => {
    jest.mocked(isUpstreamUrlPolicyEnforced).mockReturnValue(false);

    await fetchWithUpstreamUrlPolicy('http://localhost:8080/v1/models');

    expect(findUpstreamUrlViolation).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:8080/v1/models', {
      redirect: 'manual',
    });
  });
});
