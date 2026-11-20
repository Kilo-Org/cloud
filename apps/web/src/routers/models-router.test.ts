/**
 * @jest-environment node
 */
import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import type { modelsRouter as ModelsRouter } from './models-router';
import type { createCallerFactory as CreateCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { TRPCError } from '@trpc/server';

const mockGetEnhancedOpenRouterModels = jest.fn();
const mockGetPreferredModels = jest.fn();
const mockGetCustomPricingConfig = jest.fn();
const mockRequestCountryCode = jest.fn();
const mockGetPersonalModelList = jest.fn();
const mockLoadAvailableModelsForOrganization = jest.fn();
const mockResolveOrganizationAccess = jest.fn();
const mockAddAutoRoutingModels = jest.fn();

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
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/models', () => ({
  getPersonalModelList: (...args: unknown[]) => mockGetPersonalModelList(...args),
}));
jest.mock(
  '@kilocode/web-shared/routers/organizations/organization-available-models-procedure',
  () => ({
    loadAvailableModelsForOrganization: (...args: unknown[]) =>
      mockLoadAvailableModelsForOrganization(...args),
  })
);
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  resolveOrganizationAccess: (...args: unknown[]) => mockResolveOrganizationAccess(...args),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-models', () => ({
  addAutoRoutingModels: (...args: unknown[]) => mockAddAutoRoutingModels(...args),
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
  mockAddAutoRoutingModels.mockImplementation(async (data: unknown[]) => data);
  mockResolveOrganizationAccess.mockResolvedValue({ kind: 'member', role: 'member' });
});

const ORGANIZATION_ID = 'a4f1c2d3-0000-4000-8000-9a1b2c3d4e01';
const PERSONAL_LIST = { data: [{ id: 'kilo/personal' }] };
const ORGANIZATION_LIST = { data: [{ id: 'kilo/organization' }] };

function caller() {
  return createCallerFactory(modelsRouter)({
    user: { id: 'models-router-test-user' } as TRPCContext['user'],
    headersList: new Headers(),
  });
}

describe('modelsRouter.list', () => {
  it('preserves the compact shape and adds variants, alias_target, and provider ids', async () => {
    mockGetEnhancedOpenRouterModels.mockResolvedValue({
      data: [
        {
          id: 'provider/model',
          name: 'Model',
          architecture: { input_modalities: ['text', 'image'] },
          opencode: { variants: { high: {}, low: {} } },
          alias_target: 'provider/target',
          inference_provider_ids: ['provider', 'other-provider'],
        },
        {
          id: 'provider/plain',
          name: 'Plain',
          architecture: { input_modalities: ['text'] },
          opencode: { variants: {} },
        },
        {
          id: 'provider/retiring',
          name: 'No settings',
          architecture: { input_modalities: ['text'] },
          retires_on: '2026-08-01',
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
        inference_provider_ids: ['provider', 'other-provider'],
        alias_target: 'provider/target',
      },
      {
        id: 'provider/plain',
        name: 'Plain',
        supportsVision: false,
        isPreferred: false,
        variants: [],
        inference_provider_ids: [],
      },
      {
        id: 'provider/retiring',
        name: 'No settings',
        supportsVision: false,
        isPreferred: false,
        variants: [],
        inference_provider_ids: [],
        retires_on: '2026-08-01',
      },
    ]);
  });

  it('returns an empty list when the catalog has no data', async () => {
    mockGetEnhancedOpenRouterModels.mockResolvedValue({});

    await expect(caller().list()).resolves.toEqual([]);
  });
});

/**
 * The app shell's session cookie only covers `/app-shell`, so its pages cannot
 * read the REST model routes that authenticate with the web session. They read
 * this procedure through `/app-shell/api/trpc` instead, which is why it has to
 * answer both a personal and an organization caller, and why the organization
 * branch owes the same membership gate as
 * `organizations.settings.listAvailableModels`.
 */
describe('modelsRouter.selectorList', () => {
  it('answers a personal caller with their own catalog', async () => {
    mockGetPersonalModelList.mockResolvedValue(PERSONAL_LIST);

    const result = await caller().selectorList({});

    expect(result).toEqual(PERSONAL_LIST);
    expect(mockGetPersonalModelList).toHaveBeenCalledWith({
      user: { id: 'models-router-test-user' },
      countryCode: null,
      fromDb: undefined,
    });
    expect(mockResolveOrganizationAccess).not.toHaveBeenCalled();
  });

  it('answers an organization member with the requested audience', async () => {
    mockLoadAvailableModelsForOrganization.mockResolvedValue(ORGANIZATION_LIST);

    const result = await caller().selectorList({
      organizationId: ORGANIZATION_ID,
      audience: 'shared_services',
    });

    expect(mockResolveOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'models-router-test-user' }) }),
      ORGANIZATION_ID
    );
    expect(mockLoadAvailableModelsForOrganization).toHaveBeenCalledWith({
      userId: 'models-router-test-user',
      organizationId: ORGANIZATION_ID,
      audience: 'shared_services',
      headersList: expect.any(Headers),
      fromDb: undefined,
    });
    expect(result).toEqual(ORGANIZATION_LIST);
  });

  it('defaults the audience to member', async () => {
    mockLoadAvailableModelsForOrganization.mockResolvedValue(ORGANIZATION_LIST);

    await caller().selectorList({ organizationId: ORGANIZATION_ID });

    expect(mockLoadAvailableModelsForOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'member' })
    );
  });

  it('refuses an organization the caller does not belong to, before reading models', async () => {
    mockResolveOrganizationAccess.mockRejectedValue(
      new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this organization',
      })
    );

    await expect(caller().selectorList({ organizationId: ORGANIZATION_ID })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockLoadAvailableModelsForOrganization).not.toHaveBeenCalled();
  });
});
