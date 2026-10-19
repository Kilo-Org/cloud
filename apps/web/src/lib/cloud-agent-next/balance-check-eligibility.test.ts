const mockIsFreeModel = jest.fn();
const mockGetModelUserByokProviders = jest.fn();
const mockGetUserByokProviderIds = jest.fn();
const mockGetOrganizationByokProviderIds = jest.fn();

jest.mock('@kilocode/web-shared/lib/ai-gateway/is-free-model', () => ({
  isFreeModelExcludingCustomLlms: (...args: unknown[]) => mockIsFreeModel(...args),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  getModelUserByokProviders: (...args: unknown[]) => mockGetModelUserByokProviders(...args),
  getUserByokProviderIds: (...args: unknown[]) => mockGetUserByokProviderIds(...args),
  getOrganizationByokProviderIds: (...args: unknown[]) =>
    mockGetOrganizationByokProviderIds(...args),
}));

import { computeCloudAgentNextBalanceCheckEligibility } from './balance-check-eligibility';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

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

  describe('custom LLMs', () => {
    const CUSTOM_LLM_ID = 'acme/balance-custom-model';
    const ORG_ID = '00000000-0000-4000-8000-000000000001';
    const PUBLIC_CUSTOM_LLM_ID = 'acme/balance-public-model';

    beforeAll(async () => {
      await insertCustomLlmForTest(
        CUSTOM_LLM_ID,
        customLlmDefinition({ organization_ids: [ORG_ID] })
      );
      await insertCustomLlmForTest(PUBLIC_CUSTOM_LLM_ID, publicCustomLlmDefinition(['acme']));
    });

    afterAll(async () => {
      await deleteCustomLlmForTest(CUSTOM_LLM_ID);
      await deleteCustomLlmForTest(PUBLIC_CUSTOM_LLM_ID);
    });

    it('skips the balance check for a public custom LLM from a personal account', async () => {
      const result = await computeCloudAgentNextBalanceCheckEligibility({
        fromDb: fakeDb,
        user: fakeUser,
        modelId: PUBLIC_CUSTOM_LLM_ID,
      });

      expect(result).toEqual({ isFree: true, hasUserByokAvailable: false });
    });

    it('skips the balance check for a custom LLM the organization may use', async () => {
      const result = await computeCloudAgentNextBalanceCheckEligibility({
        fromDb: fakeDb,
        user: fakeUser,
        modelId: CUSTOM_LLM_ID,
        organizationId: ORG_ID,
      });

      expect(result).toEqual({ isFree: true, hasUserByokAvailable: false });
    });

    it.each([
      ['another organization', '00000000-0000-4000-8000-000000000002'],
      ['a personal account', undefined],
    ])('keeps the balance check for a custom LLM requested from %s', async (_name, orgId) => {
      const result = await computeCloudAgentNextBalanceCheckEligibility({
        fromDb: fakeDb,
        user: fakeUser,
        modelId: CUSTOM_LLM_ID,
        organizationId: orgId,
      });

      expect(result).toEqual({ isFree: false, hasUserByokAvailable: false });
      expect(mockGetModelUserByokProviders).not.toHaveBeenCalled();
    });
  });
});
