const mockIsFreeModel = jest.fn();
const mockGetModelUserByokProviders = jest.fn();
const mockGetUserByokProviderIds = jest.fn();
const mockGetOrganizationByokProviderIds = jest.fn();
const mockGetDirectByokModel = jest.fn();

jest.mock('@/lib/ai-gateway/is-free-model', () => ({
  isFreeModel: (...args: unknown[]) => mockIsFreeModel(...args),
}));

jest.mock('@/lib/ai-gateway/byok', () => ({
  getModelUserByokProviders: (...args: unknown[]) => mockGetModelUserByokProviders(...args),
  getUserByokProviderIds: (...args: unknown[]) => mockGetUserByokProviderIds(...args),
  getOrganizationByokProviderIds: (...args: unknown[]) =>
    mockGetOrganizationByokProviderIds(...args),
}));

jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModel: (...args: unknown[]) => mockGetDirectByokModel(...args),
}));

import { classifyCloudAgentModelBilling } from './classify-model-billing';

// A real Kilo-exclusive model id so the (unmocked) catalog lookup resolves.
const KILO_EXCLUSIVE_MODEL = 'deepseek/deepseek-v4-pro:discounted';
const NON_EXCLUSIVE_MODEL = 'anthropic/claude-sonnet-4';

const fakeDb = {} as never;

beforeEach(() => {
  jest.resetAllMocks();
  mockIsFreeModel.mockResolvedValue(false);
  mockGetDirectByokModel.mockResolvedValue({ provider: null, model: null });
  mockGetModelUserByokProviders.mockResolvedValue([]);
  mockGetUserByokProviderIds.mockResolvedValue([]);
  mockGetOrganizationByokProviderIds.mockResolvedValue([]);
});

describe('classifyCloudAgentModelBilling', () => {
  it('classifies a free model as free without reading BYOK configuration', async () => {
    mockIsFreeModel.mockResolvedValueOnce(true);

    const result = await classifyCloudAgentModelBilling({
      fromDb: fakeDb,
      userId: 'user-1',
      modelId: 'kilo/free-model',
    });

    expect(result).toBe('free');
    expect(mockGetModelUserByokProviders).not.toHaveBeenCalled();
  });

  it('classifies a Kilo-exclusive model as balance-required even when a BYOK provider could serve it', async () => {
    mockGetUserByokProviderIds.mockResolvedValueOnce(['openrouter']);

    const result = await classifyCloudAgentModelBilling({
      fromDb: fakeDb,
      userId: 'user-1',
      modelId: KILO_EXCLUSIVE_MODEL,
    });

    expect(result).toBe('balance-required');
    expect(mockGetModelUserByokProviders).not.toHaveBeenCalled();
    expect(mockGetUserByokProviderIds).not.toHaveBeenCalled();
    expect(mockGetOrganizationByokProviderIds).not.toHaveBeenCalled();
  });

  it('classifies a paid model as byok when the user has a matching enabled provider', async () => {
    mockGetModelUserByokProviders.mockResolvedValueOnce(['openrouter']);
    mockGetUserByokProviderIds.mockResolvedValueOnce(['openrouter']);

    const result = await classifyCloudAgentModelBilling({
      fromDb: fakeDb,
      userId: 'user-1',
      modelId: NON_EXCLUSIVE_MODEL,
    });

    expect(result).toBe('byok');
  });

  it('classifies a direct BYOK model as byok when the user has that provider enabled', async () => {
    mockGetDirectByokModel.mockResolvedValueOnce({
      provider: { id: 'chutes-byok' },
      model: { id: 'supported-model' },
    });
    mockGetUserByokProviderIds.mockResolvedValueOnce(['chutes-byok']);

    const result = await classifyCloudAgentModelBilling({
      fromDb: fakeDb,
      userId: 'user-1',
      modelId: 'chutes-byok/supported-model',
    });

    expect(result).toBe('byok');
    expect(mockGetModelUserByokProviders).not.toHaveBeenCalled();
  });

  it('classifies a paid model as balance-required when no enabled provider matches', async () => {
    mockGetModelUserByokProviders.mockResolvedValueOnce(['openrouter']);
    mockGetUserByokProviderIds.mockResolvedValueOnce(['anthropic']);

    const result = await classifyCloudAgentModelBilling({
      fromDb: fakeDb,
      userId: 'user-1',
      modelId: NON_EXCLUSIVE_MODEL,
    });

    expect(result).toBe('balance-required');
  });

  it('classifies a paid model as balance-required when no provider can route it', async () => {
    mockGetModelUserByokProviders.mockResolvedValueOnce([]);

    const result = await classifyCloudAgentModelBilling({
      fromDb: fakeDb,
      userId: 'user-1',
      modelId: NON_EXCLUSIVE_MODEL,
    });

    expect(result).toBe('balance-required');
    expect(mockGetUserByokProviderIds).not.toHaveBeenCalled();
  });

  it('uses organization BYOK providers when organizationId is provided', async () => {
    mockGetModelUserByokProviders.mockResolvedValueOnce(['openrouter']);
    mockGetOrganizationByokProviderIds.mockResolvedValueOnce(['openrouter']);

    const result = await classifyCloudAgentModelBilling({
      fromDb: fakeDb,
      userId: 'user-1',
      modelId: NON_EXCLUSIVE_MODEL,
      organizationId: 'org-1',
    });

    expect(result).toBe('byok');
    expect(mockGetOrganizationByokProviderIds).toHaveBeenCalledWith(fakeDb, 'org-1');
    expect(mockGetUserByokProviderIds).not.toHaveBeenCalled();
  });
});
