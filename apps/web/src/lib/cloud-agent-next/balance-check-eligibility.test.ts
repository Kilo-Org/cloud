const mockIsFreeModel = jest.fn();
const mockGetModelUserByokProviders = jest.fn();
const mockGetUserByokProviderIds = jest.fn();
const mockGetOrganizationByokProviderIds = jest.fn();

jest.mock('@/lib/ai-gateway/is-free-model', () => ({
  isFreeModel: (...args: unknown[]) => mockIsFreeModel(...args),
}));

jest.mock('@/lib/ai-gateway/byok', () => ({
  getModelUserByokProviders: (...args: unknown[]) => mockGetModelUserByokProviders(...args),
  getUserByokProviderIds: (...args: unknown[]) => mockGetUserByokProviderIds(...args),
  getOrganizationByokProviderIds: (...args: unknown[]) =>
    mockGetOrganizationByokProviderIds(...args),
}));

const mockCanRouteToVercel = jest.fn();
const mockResolveOrganizationMemberModelDecision = jest.fn();

jest.mock('@/lib/ai-gateway/providers/vercel', () => ({
  canRouteToVercel: (...args: unknown[]) => mockCanRouteToVercel(...args),
}));

jest.mock('@/lib/organizations/effective-model-access.server', () => ({
  resolveOrganizationMemberModelDecision: (...args: unknown[]) =>
    mockResolveOrganizationMemberModelDecision(...args),
}));

import { computeCloudAgentNextBalanceCheckEligibility } from './balance-check-eligibility';

const KILO_EXCLUSIVE_MODEL = 'stealth/qwen3.6-plus';
const NON_EXCLUSIVE_MODEL = 'anthropic/claude-sonnet-4';

const fakeDb = {} as never;
const fakeUser = { id: 'user-1' };

beforeEach(() => {
  jest.resetAllMocks();
  mockIsFreeModel.mockReturnValue(false);
  mockGetModelUserByokProviders.mockResolvedValue([]);
  mockGetUserByokProviderIds.mockResolvedValue([]);
  mockGetOrganizationByokProviderIds.mockResolvedValue([]);
});

describe('computeCloudAgentNextBalanceCheckEligibility', () => {
  it('returns isFree and skips BYOK when the model is free', async () => {
    mockIsFreeModel.mockReturnValueOnce(true);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: 'kilo/free-model',
    });

    expect(result).toEqual({ isFree: true, hasUserByokAvailable: false });
    expect(mockGetModelUserByokProviders).not.toHaveBeenCalled();
  });

  it('returns hasUserByokAvailable: false for a Kilo-exclusive model even when BYOK providers can serve it', async () => {
    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: KILO_EXCLUSIVE_MODEL,
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: false });
    expect(mockGetModelUserByokProviders).not.toHaveBeenCalled();
    expect(mockGetUserByokProviderIds).not.toHaveBeenCalled();
    expect(mockGetOrganizationByokProviderIds).not.toHaveBeenCalled();
  });

  it('returns hasUserByokAvailable: false for a Kilo-exclusive model even when the user has an enabled matching BYOK provider', async () => {
    mockGetUserByokProviderIds.mockResolvedValueOnce(['openrouter']);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: KILO_EXCLUSIVE_MODEL,
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: false });
    expect(mockGetModelUserByokProviders).not.toHaveBeenCalled();
    expect(mockGetUserByokProviderIds).not.toHaveBeenCalled();
  });

  it('returns hasUserByokAvailable: false for a Kilo-exclusive model in an organization context', async () => {
    mockGetOrganizationByokProviderIds.mockResolvedValueOnce(['openrouter']);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: KILO_EXCLUSIVE_MODEL,
      organizationId: 'org-1',
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: false });
    expect(mockGetModelUserByokProviders).not.toHaveBeenCalled();
    expect(mockGetOrganizationByokProviderIds).not.toHaveBeenCalled();
  });

  it('returns hasUserByokAvailable: true for a non-Kilo-exclusive paid model with a matching enabled user BYOK provider', async () => {
    mockGetModelUserByokProviders.mockResolvedValueOnce(['openrouter']);
    mockGetUserByokProviderIds.mockResolvedValueOnce(['openrouter']);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: NON_EXCLUSIVE_MODEL,
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: true });
  });

  it('returns hasUserByokAvailable: false for a non-Kilo-exclusive paid model with no matching BYOK provider', async () => {
    mockGetModelUserByokProviders.mockResolvedValueOnce(['openrouter']);
    mockGetUserByokProviderIds.mockResolvedValueOnce(['anthropic']);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: NON_EXCLUSIVE_MODEL,
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: false });
  });

  it('returns hasUserByokAvailable: false for a non-Kilo-exclusive paid model with no resolvable providers', async () => {
    mockGetModelUserByokProviders.mockResolvedValueOnce([]);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: NON_EXCLUSIVE_MODEL,
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: false });
    expect(mockGetUserByokProviderIds).not.toHaveBeenCalled();
  });

  it('uses organization BYOK providers for a non-Kilo-exclusive paid model when organizationId is provided', async () => {
    mockGetModelUserByokProviders.mockResolvedValueOnce(['openrouter']);
    mockGetOrganizationByokProviderIds.mockResolvedValueOnce(['openrouter']);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: NON_EXCLUSIVE_MODEL,
      organizationId: 'org-1',
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: true });
    expect(mockGetOrganizationByokProviderIds).toHaveBeenCalledWith(fakeDb, 'org-1');
    expect(mockGetUserByokProviderIds).not.toHaveBeenCalled();
  });

  describe('organization Vercel AI Gateway key', () => {
    beforeEach(() => {
      mockGetModelUserByokProviders.mockResolvedValue(['vercel-ai-gateway']);
      mockGetOrganizationByokProviderIds.mockResolvedValue(['vercel-ai-gateway']);
      mockResolveOrganizationMemberModelDecision.mockResolvedValue({
        decision: { allowed: true, eligibleProviderRoutes: new Set(['groq', 'virtual']) },
      });
    });

    async function eligibility() {
      return computeCloudAgentNextBalanceCheckEligibility({
        fromDb: fakeDb,
        user: fakeUser,
        modelId: NON_EXCLUSIVE_MODEL,
        organizationId: 'org-1',
      });
    }

    it('counts the key when Vercel can honor the allowed providers', async () => {
      mockCanRouteToVercel.mockResolvedValue(true);

      expect(await eligibility()).toEqual({ isFree: false, hasUserByokAvailable: true });
      expect(mockResolveOrganizationMemberModelDecision).toHaveBeenCalledWith({
        organizationId: 'org-1',
        kiloUserId: fakeUser.id,
        modelId: NON_EXCLUSIVE_MODEL,
      });
      const getRoutingProviderConfig = mockCanRouteToVercel.mock
        .calls[0][1] as () => Promise<unknown>;
      await expect(getRoutingProviderConfig()).resolves.toEqual({ only: ['groq'] });
    });

    it('does not count the key when routing would fall through to a Kilo-paid route', async () => {
      mockCanRouteToVercel.mockResolvedValue(false);

      expect(await eligibility()).toEqual({ isFree: false, hasUserByokAvailable: false });
    });

    it('counts the key without a routing check when the organization allows every provider', async () => {
      mockResolveOrganizationMemberModelDecision.mockResolvedValue({
        decision: { allowed: true },
      });

      expect(await eligibility()).toEqual({ isFree: false, hasUserByokAvailable: true });
      expect(mockCanRouteToVercel).not.toHaveBeenCalled();
    });
  });
});
