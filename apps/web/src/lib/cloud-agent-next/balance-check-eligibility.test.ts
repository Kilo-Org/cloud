const mockIsFreeModel = jest.fn();
const mockGetModelUserByokProviders = jest.fn();
const mockGetUserByokProviderIds = jest.fn();
const mockGetOrganizationByokProviderIds = jest.fn();

jest.mock('@kilocode/web-shared/lib/ai-gateway/is-free-model', () => ({
  isFreeModel: (...args: unknown[]) => mockIsFreeModel(...args),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  getModelUserByokProviders: (...args: unknown[]) => mockGetModelUserByokProviders(...args),
  getUserByokProviderIds: (...args: unknown[]) => mockGetUserByokProviderIds(...args),
  getOrganizationByokProviderIds: (...args: unknown[]) =>
    mockGetOrganizationByokProviderIds(...args),
}));

const mockCanRouteToVercel = jest.fn();
const mockResolveOrganizationMemberModelDecision = jest.fn();

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  canRouteToVercel: (...args: unknown[]) => mockCanRouteToVercel(...args),
}));

jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    resolveOrganizationMemberModelDecision: (...args: unknown[]) =>
      mockResolveOrganizationMemberModelDecision(...args),
  })
);

const mockGetOpenAiChatGptStoredConnection = jest.fn();

jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store'),
  getOpenAiChatGptStoredConnection: (...args: unknown[]) =>
    mockGetOpenAiChatGptStoredConnection(...args),
}));

const CONNECTED_CHATGPT = { connection: { status: 'connected' }, isEnabled: true };

import { computeCloudAgentNextBalanceCheckEligibility } from './balance-check-eligibility';

const PAID_MODEL = 'anthropic/claude-sonnet-4';

const fakeDb = {} as never;
const fakeUser = { id: 'user-1' };

beforeEach(() => {
  jest.resetAllMocks();
  mockIsFreeModel.mockReturnValue(false);
  mockGetModelUserByokProviders.mockResolvedValue([]);
  mockGetUserByokProviderIds.mockResolvedValue([]);
  mockGetOrganizationByokProviderIds.mockResolvedValue([]);
  mockResolveOrganizationMemberModelDecision.mockResolvedValue({ decision: { allowed: true } });
  mockGetOpenAiChatGptStoredConnection.mockResolvedValue(null);
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

  it('returns hasUserByokAvailable: true for a paid model with a matching enabled user BYOK provider', async () => {
    mockGetModelUserByokProviders.mockResolvedValueOnce(['openrouter']);
    mockGetUserByokProviderIds.mockResolvedValueOnce(['openrouter']);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: PAID_MODEL,
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: true });
  });

  it('returns hasUserByokAvailable: false for a paid model with no matching BYOK provider', async () => {
    mockGetModelUserByokProviders.mockResolvedValueOnce(['openrouter']);
    mockGetUserByokProviderIds.mockResolvedValueOnce(['anthropic']);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: PAID_MODEL,
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: false });
  });

  it('returns hasUserByokAvailable: false for a paid model with no resolvable providers', async () => {
    mockGetUserByokProviderIds.mockResolvedValueOnce(['anthropic']);
    mockGetModelUserByokProviders.mockResolvedValueOnce([]);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: PAID_MODEL,
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: false });
    expect(mockGetModelUserByokProviders).toHaveBeenCalledWith(PAID_MODEL, new Set(['anthropic']));
  });

  it('skips model provider discovery when the owner has no enabled keys', async () => {
    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: PAID_MODEL,
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: false });
    expect(mockGetUserByokProviderIds).toHaveBeenCalledWith(fakeDb, fakeUser.id);
    expect(mockGetModelUserByokProviders).not.toHaveBeenCalled();
  });

  it('uses organization BYOK providers for a paid model when organizationId is provided', async () => {
    mockGetModelUserByokProviders.mockResolvedValueOnce(['openrouter']);
    mockGetOrganizationByokProviderIds.mockResolvedValueOnce(['openrouter']);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: PAID_MODEL,
      organizationId: 'org-1',
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: true });
    expect(mockGetOrganizationByokProviderIds).toHaveBeenCalledWith(fakeDb, 'org-1');
    expect(mockGetUserByokProviderIds).not.toHaveBeenCalled();
  });

  it('counts a connected ChatGPT connection for an OpenAI model', async () => {
    mockGetOpenAiChatGptStoredConnection.mockResolvedValue(CONNECTED_CHATGPT);

    const result = await computeCloudAgentNextBalanceCheckEligibility({
      fromDb: fakeDb,
      user: fakeUser,
      modelId: 'openai/gpt-5',
    });

    expect(result).toEqual({ isFree: false, hasUserByokAvailable: true });
    expect(mockGetOpenAiChatGptStoredConnection).toHaveBeenCalledWith({
      kiloUserId: fakeUser.id,
      organizationId: null,
    });
  });

  it("counts the organization's shared-services ChatGPT connection for service runs", async () => {
    mockGetOpenAiChatGptStoredConnection.mockImplementation(async (owner: { scope?: string }) =>
      owner.scope === 'shared_services' ? CONNECTED_CHATGPT : null
    );

    const eligibility = (includeSharedServicesConnection: boolean) =>
      computeCloudAgentNextBalanceCheckEligibility({
        fromDb: fakeDb,
        user: fakeUser,
        modelId: 'openai/gpt-5',
        organizationId: 'org-1',
        includeSharedServicesConnection,
      });

    expect(await eligibility(true)).toEqual({ isFree: false, hasUserByokAvailable: true });
    expect(await eligibility(false)).toEqual({ isFree: false, hasUserByokAvailable: false });
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
        modelId: PAID_MODEL,
        organizationId: 'org-1',
      });
    }

    it('counts the key when Vercel can honor the allowed providers', async () => {
      mockCanRouteToVercel.mockResolvedValue(true);

      expect(await eligibility()).toEqual({ isFree: false, hasUserByokAvailable: true });
      expect(mockResolveOrganizationMemberModelDecision).toHaveBeenCalledWith({
        organizationId: 'org-1',
        kiloUserId: fakeUser.id,
        allowNonMember: true,
        modelId: PAID_MODEL,
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

    it('does not count the key when it does not serve the model', async () => {
      mockGetModelUserByokProviders.mockResolvedValue(['openrouter']);
      mockGetOrganizationByokProviderIds.mockResolvedValue(['vercel-ai-gateway']);

      expect(await eligibility()).toEqual({ isFree: false, hasUserByokAvailable: false });
    });
  });

  describe('organization provider key sent through Vercel', () => {
    beforeEach(() => {
      mockGetModelUserByokProviders.mockResolvedValue(['bedrock']);
      mockGetOrganizationByokProviderIds.mockResolvedValue(['bedrock']);
    });

    async function eligibility() {
      return computeCloudAgentNextBalanceCheckEligibility({
        fromDb: fakeDb,
        user: fakeUser,
        modelId: PAID_MODEL,
        organizationId: 'org-1',
      });
    }

    it('counts a key the provider allow-list admits', async () => {
      mockResolveOrganizationMemberModelDecision.mockResolvedValue({
        decision: { allowed: true, eligibleProviderRoutes: new Set(['amazon-bedrock']) },
      });

      expect(await eligibility()).toEqual({ isFree: false, hasUserByokAvailable: true });
    });

    it('does not count a key outside the provider allow-list', async () => {
      mockResolveOrganizationMemberModelDecision.mockResolvedValue({
        decision: { allowed: true, eligibleProviderRoutes: new Set(['anthropic']) },
      });

      expect(await eligibility()).toEqual({ isFree: false, hasUserByokAvailable: false });
    });

    it('does not count a key when no allowed provider serves the model', async () => {
      mockResolveOrganizationMemberModelDecision.mockResolvedValue({
        decision: { allowed: false, denialSource: 'organization_provider' },
      });

      expect(await eligibility()).toEqual({ isFree: false, hasUserByokAvailable: false });
    });
  });
});
