import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createAnonymousContext } from '@/lib/anonymous';
import type * as EnforcementModule from './free-model-rate-limit-enforcement';

type RateLimitResult = { allowed: boolean; requestCount: number };
type ConsumeRateLimit = (subject: string) => Promise<RateLimitResult>;
type ConsumeAnonymousRateLimits = (ipAddress: string) => Promise<{
  freeModel: RateLimitResult;
  promotion: RateLimitResult;
}>;

const mockCheckPromotionLimit = jest.fn<ConsumeRateLimit>();
const mockConsumeAnonymousRateLimits = jest.fn<ConsumeAnonymousRateLimits>();
const mockConsumeIpRateLimit = jest.fn<ConsumeRateLimit>();
const mockConsumeUserRateLimit = jest.fn<ConsumeRateLimit>();
const mockIsCloudflareIp = jest.fn<(ipAddress: string) => boolean>();

jest.mock('@/lib/free-model-rate-limiter', () => ({
  checkPromotionLimit: mockCheckPromotionLimit,
  consumeAnonymousFreeModelRateLimits: mockConsumeAnonymousRateLimits,
  consumeFreeModelRateLimit: mockConsumeIpRateLimit,
  consumeFreeModelRateLimitByUser: mockConsumeUserRateLimit,
}));

jest.mock('@/lib/cloudflare-ip', () => ({
  isCloudflareIP: mockIsCloudflareIp,
}));

let enforceFreeModelRateLimits: typeof EnforcementModule.enforceFreeModelRateLimits;
const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

describe('free model rate limit enforcement', () => {
  beforeAll(async () => {
    ({ enforceFreeModelRateLimits } = await import('./free-model-rate-limit-enforcement'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCloudflareIp.mockReturnValue(false);
    mockCheckPromotionLimit.mockResolvedValue({ allowed: true, requestCount: 0 });
    mockConsumeAnonymousRateLimits.mockResolvedValue({
      freeModel: { allowed: true, requestCount: 1 },
      promotion: { allowed: true, requestCount: 1 },
    });
    mockConsumeIpRateLimit.mockResolvedValue({ allowed: true, requestCount: 1 });
    mockConsumeUserRateLimit.mockResolvedValue({ allowed: true, requestCount: 1 });
  });

  afterAll(() => {
    consoleWarnSpy.mockRestore();
  });

  it('consumes both limits for an anonymous Kilo free-model request', async () => {
    const response = await enforceFreeModelRateLimits({
      feature: 'vscode-extension',
      ipAddress: '192.0.2.1',
      isRateLimitedFreeModel: true,
      model: 'kilo/free-model',
      user: createAnonymousContext('192.0.2.1'),
    });

    expect(response).toBeNull();
    expect(mockConsumeAnonymousRateLimits).toHaveBeenCalledWith('192.0.2.1');
    expect(mockCheckPromotionLimit).not.toHaveBeenCalled();
  });

  it('only checks promotion usage for an anonymous third-party free model', async () => {
    const response = await enforceFreeModelRateLimits({
      feature: 'vscode-extension',
      ipAddress: '192.0.2.1',
      isRateLimitedFreeModel: false,
      model: 'provider/free-model',
      user: createAnonymousContext('192.0.2.1'),
    });

    expect(response).toBeNull();
    expect(mockCheckPromotionLimit).toHaveBeenCalledWith('192.0.2.1');
    expect(mockConsumeAnonymousRateLimits).not.toHaveBeenCalled();
  });

  it('requires authentication for user-limited infrastructure requests', async () => {
    mockIsCloudflareIp.mockReturnValue(true);

    const response = await enforceFreeModelRateLimits({
      feature: 'cloud-agent',
      ipAddress: '192.0.2.1',
      isRateLimitedFreeModel: true,
      model: 'kilo/free-model',
      user: createAnonymousContext('192.0.2.1'),
    });

    expect(response?.status).toBe(401);
    if (!response) throw new Error('Expected an authentication response');
    await expect(response.json()).resolves.toEqual({
      error: 'Authentication required for this feature',
      error_type: 'authentication_required',
    });
    expect(mockConsumeAnonymousRateLimits).not.toHaveBeenCalled();
  });

  it('uses a user limit for authenticated infrastructure requests', async () => {
    mockIsCloudflareIp.mockReturnValue(true);

    const response = await enforceFreeModelRateLimits({
      feature: 'cloud-agent',
      ipAddress: '192.0.2.1',
      isRateLimitedFreeModel: true,
      model: 'kilo/free-model',
      user: { id: 'user-123' },
    });

    expect(response).toBeNull();
    expect(mockConsumeUserRateLimit).toHaveBeenCalledWith('user-123');
    expect(mockConsumeIpRateLimit).not.toHaveBeenCalled();
  });

  it('returns the free-model limit response when the IP limit is exhausted', async () => {
    mockConsumeIpRateLimit.mockResolvedValue({ allowed: false, requestCount: 200 });

    const response = await enforceFreeModelRateLimits({
      feature: 'vscode-extension',
      ipAddress: '192.0.2.1',
      isRateLimitedFreeModel: true,
      model: 'kilo/free-model',
      user: { id: 'user-123' },
    });

    expect(response?.status).toBe(429);
    if (!response) throw new Error('Expected a rate-limit response');
    await expect(response.json()).resolves.toMatchObject({
      error: 'Rate limit exceeded',
      error_type: 'rate_limit_exceeded',
    });
  });

  it('returns the promotion response when anonymous usage is exhausted', async () => {
    mockCheckPromotionLimit.mockResolvedValue({ allowed: false, requestCount: 10_000 });

    const response = await enforceFreeModelRateLimits({
      feature: 'vscode-extension',
      ipAddress: '192.0.2.1',
      isRateLimitedFreeModel: false,
      model: 'provider/free-model',
      user: createAnonymousContext('192.0.2.1'),
    });

    expect(response?.status).toBe(401);
    if (!response) throw new Error('Expected a promotion-limit response');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROMOTION_MODEL_LIMIT_REACHED' },
      error_type: 'promotion_limit_reached',
    });
  });
});
