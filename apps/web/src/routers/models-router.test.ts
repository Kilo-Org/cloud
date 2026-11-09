/**
 * @jest-environment node
 */
import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import type { modelsRouter as ModelsRouter } from './models-router';
import type { createCallerFactory as CreateCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';

const mockGetEnhancedOpenRouterModels = jest.fn();
const mockGetPreferredModels = jest.fn();
const mockGetCustomPricingConfig = jest.fn();
const mockRequestCountryCode = jest.fn();

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: (...args: unknown[]) => mockGetEnhancedOpenRouterModels(...args),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/preferred-models', () => ({
  getPreferredModels: (...args: unknown[]) => mockGetPreferredModels(...args),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-pricing-config', () => ({
  getCustomPricingConfig: (...args: unknown[]) => mockGetCustomPricingConfig(...args),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list', () => ({
  requestCountryCode: (...args: unknown[]) => mockRequestCountryCode(...args),
}));

let modelsRouter: typeof ModelsRouter;
let createCallerFactory: typeof CreateCallerFactory;

beforeAll(async () => {
  [{ modelsRouter }, { createCallerFactory }] = await Promise.all([
    import('./models-router'),
    import('@kilocode/web-shared/lib/trpc/init'),
  ]);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPreferredModels.mockResolvedValue([]);
  mockGetCustomPricingConfig.mockReturnValue({});
  mockRequestCountryCode.mockReturnValue(null);
});

function caller() {
  return createCallerFactory(modelsRouter)({
    user: { id: 'models-router-test-user' } as TRPCContext['user'],
    headersList: new Headers(),
  });
}

describe('modelsRouter.list', () => {
  it('preserves the existing compact shape and adds variants and alias_target', async () => {
    mockGetEnhancedOpenRouterModels.mockResolvedValue({
      data: [
        {
          id: 'provider/model',
          name: 'Model',
          architecture: { input_modalities: ['text', 'image'] },
          opencode: { variants: { high: {}, low: {} } },
          alias_target: 'provider/target',
        },
        {
          id: 'provider/plain',
          name: 'Plain',
          architecture: { input_modalities: ['text'] },
          opencode: { variants: {} },
        },
        {
          id: 'provider/no-settings',
          name: 'No settings',
          architecture: { input_modalities: ['text'] },
        },
      ],
    });
    mockGetPreferredModels.mockResolvedValue(['provider/model']);

    const result = await caller().list();

    expect(result).toEqual([
      {
        id: 'provider/model',
        name: 'Model',
        supportsVision: true,
        isPreferred: true,
        variants: ['high', 'low'],
        alias_target: 'provider/target',
      },
      {
        id: 'provider/plain',
        name: 'Plain',
        supportsVision: false,
        isPreferred: false,
        variants: [],
      },
      {
        id: 'provider/no-settings',
        name: 'No settings',
        supportsVision: false,
        isPreferred: false,
        variants: [],
      },
    ]);
  });

  it('returns an empty list when the catalog has no data', async () => {
    mockGetEnhancedOpenRouterModels.mockResolvedValue({});

    await expect(caller().list()).resolves.toEqual([]);
  });
});
