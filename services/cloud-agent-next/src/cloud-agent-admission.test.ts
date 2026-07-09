import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCloudAgentAdmission } from './cloud-agent-admission.js';
import type { Env } from './types.js';

vi.mock('./logger.js', () => ({
  logger: {
    withFields: () => ({ error: vi.fn(), warn: vi.fn() }),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('checkCloudAgentAdmission', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  const mockEnv = {
    KILOCODE_BACKEND_BASE_URL: 'https://app.kilo.ai',
  } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function okWith(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as Response;
  }

  it('returns classification without balance for a non-balance-required model', async () => {
    fetchMock.mockResolvedValue(
      okWith({ classification: 'byok', balance: null, isDepleted: null })
    );

    const result = await checkCloudAgentAdmission({
      env: mockEnv,
      token: 'jwt-token',
      modelId: 'anthropic/claude-sonnet-4',
      owner: { userId: 'user-1' },
    });

    expect(result).toEqual({ classification: 'byok', balance: null, isDepleted: null });
  });

  it('returns classification with balance for a balance-required model', async () => {
    fetchMock.mockResolvedValue(
      okWith({ classification: 'balance-required', balance: 5, isDepleted: false })
    );

    const result = await checkCloudAgentAdmission({
      env: mockEnv,
      token: 'jwt-token',
      modelId: 'anthropic/claude-sonnet-4',
      owner: { userId: 'user-1' },
    });

    expect(result).toEqual({ classification: 'balance-required', balance: 5, isDepleted: false });
  });

  it('posts the model with the bearer token and no org header for a user owner', async () => {
    fetchMock.mockResolvedValue(
      okWith({ classification: 'free', balance: null, isDepleted: null })
    );

    await checkCloudAgentAdmission({
      env: mockEnv,
      token: 'jwt-token',
      modelId: 'kilo/free-model',
      owner: { userId: 'user-1' },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app.kilo.ai/api/profile/cloud-agent-admission');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ modelId: 'kilo/free-model' }));
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer jwt-token');
    expect(headers.get('X-KiloCode-OrganizationId')).toBeNull();
  });

  it('sends the organization header for an organization owner', async () => {
    fetchMock.mockResolvedValue(
      okWith({ classification: 'byok', balance: null, isDepleted: null })
    );

    await checkCloudAgentAdmission({
      env: mockEnv,
      token: 'jwt-token',
      modelId: 'anthropic/claude-sonnet-4',
      owner: { organizationId: 'org-1' },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('X-KiloCode-OrganizationId')).toBe('org-1');
  });

  it('falls back to the default backend URL when none is configured', async () => {
    fetchMock.mockResolvedValue(
      okWith({ classification: 'free', balance: null, isDepleted: null })
    );

    await checkCloudAgentAdmission({
      env: { ...mockEnv, KILOCODE_BACKEND_BASE_URL: undefined } as Env,
      token: 'jwt-token',
      modelId: 'kilo/free-model',
      owner: { userId: 'user-1' },
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.kilo.ai/api/profile/cloud-agent-admission');
  });

  it.each([
    ['fetch rejects', () => fetchMock.mockRejectedValue(new Error('Network error'))],
    ['non-ok response', () => fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response)],
    [
      'non-JSON body',
      () =>
        fetchMock.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('Invalid JSON');
          },
        } as unknown as Response),
    ],
    ['unexpected shape', () => fetchMock.mockResolvedValue(okWith({ classification: 'unknown' }))],
  ])('throws a retryable SERVICE_UNAVAILABLE on %s', async (_label, arrange) => {
    arrange();

    await expect(
      checkCloudAgentAdmission({
        env: mockEnv,
        token: 'jwt-token',
        modelId: 'anthropic/claude-sonnet-4',
        owner: { userId: 'user-1' },
      })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
