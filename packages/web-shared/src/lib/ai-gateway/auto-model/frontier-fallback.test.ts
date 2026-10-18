import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as AdminClient from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import type * as ModelAccess from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import type * as OpenRouter from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import type * as ExclusiveModels from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import type * as ProviderIndex from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import type * as FrontierFallback from './frontier-fallback';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client', () => ({
  getFrontierFallback: jest.fn(),
  initializeFrontierFallback: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  getEffectiveModelDecision: jest.fn(),
  resolveOrganizationDefaultModelPolicy: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models', () => ({
  findKiloExclusiveModel: jest.fn(),
}));
jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server',
  () => ({ getModelIdToProviderSlugsIndex: jest.fn() })
);

const { getFrontierFallback, initializeFrontierFallback } = jest.requireMock<
  jest.Mocked<typeof AdminClient>
>('@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client');
const { getEffectiveModelDecision, resolveOrganizationDefaultModelPolicy } = jest.requireMock<
  jest.Mocked<typeof ModelAccess>
>('@kilocode/web-shared/lib/organizations/effective-model-access.server');
const { getEnhancedOpenRouterModels } = jest.requireMock<jest.Mocked<typeof OpenRouter>>(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter'
);
const { findKiloExclusiveModel } = jest.requireMock<jest.Mocked<typeof ExclusiveModels>>(
  '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models'
);
const { getModelIdToProviderSlugsIndex } = jest.requireMock<jest.Mocked<typeof ProviderIndex>>(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server'
);
const { getOwnerFrontierFallback, resolveEligibleFrontierFallback } =
  jest.requireActual<typeof FrontierFallback>('./frontier-fallback');

const sonnet = { model: 'anthropic/claude-sonnet-5.5', variant: 'medium' };
const opus = { model: 'anthropic/claude-opus-5.5', variant: 'medium' };
const owner = { userId: 'member-1', organizationId: 'organization-1' };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getFrontierFallback).mockResolvedValue({
    status: 200,
    body: { configuredPool: null },
  } as never);
  jest.mocked(initializeFrontierFallback).mockImplementation(
    async params =>
      ({
        status: 200,
        body: { configuredPool: null, frontierFallback: params.frontierFallback },
      }) as never
  );
  jest.mocked(resolveOrganizationDefaultModelPolicy).mockResolvedValue({
    requireModelInCurrentSnapshot: true,
    organizationModelDenyList: [],
    memberGrant: {
      mode: 'selected',
      includeOrganizationBaseline: false,
      modelAllowList: ['unrelated/default-group-model'],
      providerAllowList: [],
    },
    policyRevision: 1,
  });
  jest.mocked(getEffectiveModelDecision).mockResolvedValue({ allowed: true });
  jest.mocked(getModelIdToProviderSlugsIndex).mockResolvedValue(
    new Map([
      [sonnet.model, new Set(['anthropic'])],
      [opus.model, new Set(['anthropic'])],
    ])
  );
  jest.mocked(findKiloExclusiveModel).mockReturnValue(null);
  jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({
    data: [sonnet, opus].map(entry => ({
      id: entry.model,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      context_length: 200_000,
      opencode: {
        variants: {
          medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
        },
      },
    })),
  } as never);
});

describe('getOwnerFrontierFallback', () => {
  it('initializes only organization settings using the organization baseline', async () => {
    await expect(getOwnerFrontierFallback(owner)).resolves.toEqual(sonnet);
    expect(getFrontierFallback).toHaveBeenCalledTimes(1);
    expect(getFrontierFallback).toHaveBeenCalledWith({
      ownerType: 'org',
      ownerId: owner.organizationId,
    });
    expect(getEffectiveModelDecision).toHaveBeenCalledWith(
      expect.objectContaining({ memberGrant: { mode: 'organization_baseline' } }),
      sonnet.model
    );
    expect(initializeFrontierFallback).toHaveBeenCalledWith({
      ownerType: 'org',
      ownerId: owner.organizationId,
      frontierFallback: sonnet,
    });
  });

  it('initializes a personal owner without consulting organization policy', async () => {
    await expect(getOwnerFrontierFallback({ ...owner, organizationId: null })).resolves.toEqual(
      sonnet
    );
    expect(getFrontierFallback).toHaveBeenCalledWith({ ownerType: 'user', ownerId: owner.userId });
    expect(resolveOrganizationDefaultModelPolicy).not.toHaveBeenCalled();
  });

  it('chooses allowed Opus when Sonnet is excluded by the organization baseline', async () => {
    jest
      .mocked(getEffectiveModelDecision)
      .mockImplementation(async (_, model) => ({ allowed: model === opus.model }));
    await expect(getOwnerFrontierFallback(owner)).resolves.toEqual(opus);
  });

  it('persists explicit null when the organization baseline excludes both defaults', async () => {
    jest.mocked(getEffectiveModelDecision).mockResolvedValue({ allowed: false });
    await expect(getOwnerFrontierFallback(owner)).resolves.toBeNull();
    expect(initializeFrontierFallback).toHaveBeenCalledWith(
      expect.objectContaining({ frontierFallback: null })
    );
  });

  it('chooses Opus when the current catalog no longer exposes Sonnet medium', async () => {
    const catalog = await getEnhancedOpenRouterModels();
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({
      data: catalog.data.filter(model => model.id === opus.model),
    });
    await expect(getOwnerFrontierFallback(owner)).resolves.toEqual(opus);
  });

  it.each([null, opus])('preserves an explicit saved setting %j', async frontierFallback => {
    jest.mocked(getFrontierFallback).mockResolvedValue({
      status: 200,
      body: { configuredPool: null, frontierFallback },
    } as never);
    await expect(getOwnerFrontierFallback(owner)).resolves.toEqual(frontierFallback);
    expect(initializeFrontierFallback).not.toHaveBeenCalled();
    expect(resolveOrganizationDefaultModelPolicy).not.toHaveBeenCalled();
  });

  it('returns the atomic initialization winner rather than its proposed default', async () => {
    jest.mocked(initializeFrontierFallback).mockResolvedValue({
      status: 200,
      body: { configuredPool: null, frontierFallback: opus },
    } as never);
    await expect(getOwnerFrontierFallback(owner)).resolves.toEqual(opus);
  });

  it('does not persist a fallback while the provider policy snapshot is unavailable', async () => {
    jest.mocked(getModelIdToProviderSlugsIndex).mockResolvedValueOnce(new Map());
    await expect(getOwnerFrontierFallback(owner)).rejects.toThrow(
      'Frontier fallback model policy snapshot is unavailable'
    );
    expect(initializeFrontierFallback).not.toHaveBeenCalled();
    await expect(getOwnerFrontierFallback(owner)).resolves.toEqual(sonnet);
  });

  it.each([{ ids: [] }, { ids: ['kilo-auto/frontier', 'kilo/synthetic-exclusive'] }])(
    'does not persist null when default models are unavailable among $ids',
    async ({ ids }) => {
      const catalog = await getEnhancedOpenRouterModels();
      jest.mocked(getEnhancedOpenRouterModels).mockResolvedValueOnce({
        data: ids.flatMap(id => catalog.data.slice(0, 1).map(model => ({ ...model, id }))),
      });
      await expect(getOwnerFrontierFallback(owner)).rejects.toThrow(
        'Frontier fallback model catalog is unavailable'
      );
      expect(initializeFrontierFallback).not.toHaveBeenCalled();
    }
  );
});

describe('resolveEligibleFrontierFallback', () => {
  const context = {
    apiKind: 'messages' as const,
    body: { messages: [{ role: 'user', content: 'hello' }] },
    isModelAllowed: async () => true,
  };

  it('applies exact catalog variant settings', async () => {
    await expect(resolveEligibleFrontierFallback(sonnet, context)).resolves.toEqual({
      model: sonnet.model,
      reasoning: { enabled: true, effort: 'medium' },
      verbosity: 'medium',
    });
  });

  it('rejects a shared organization default for a disjoint member grant without changing it', async () => {
    await expect(
      resolveEligibleFrontierFallback(sonnet, { ...context, isModelAllowed: async () => false })
    ).resolves.toBeNull();
    expect(initializeFrontierFallback).not.toHaveBeenCalled();
  });

  it('rejects missing exact variants and rejects implicit defaults for models with variants', async () => {
    await expect(
      resolveEligibleFrontierFallback({ ...sonnet, variant: 'missing' }, context)
    ).resolves.toBeNull();
    await expect(
      resolveEligibleFrontierFallback({ ...sonnet, variant: null }, context)
    ).resolves.toBeNull();
  });

  it('rejects a catalog-removed model', async () => {
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({ data: [] });
    await expect(resolveEligibleFrontierFallback(sonnet, context)).resolves.toBeNull();
  });

  it('rejects unsupported required image input', async () => {
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({
      data: [
        {
          id: sonnet.model,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          context_length: 200_000,
        },
      ],
    } as never);
    await expect(
      resolveEligibleFrontierFallback(sonnet, {
        ...context,
        body: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: 'https://example.test/image.png' } },
              ],
            },
          ],
        },
      })
    ).resolves.toBeNull();
  });

  it.each([
    {
      apiKind: 'messages' as const,
      body: {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
              },
            ],
          },
        ],
      },
    },
    {
      apiKind: 'responses' as const,
      body: {
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_file',
                filename: 'report.pdf',
                file_data: 'data:application/pdf;base64,JVBERi0xLjQ=',
              },
            ],
          },
        ],
      },
    },
  ])('accepts PDF input for a PDF-capable fallback on $apiKind', async request => {
    const catalog = await getEnhancedOpenRouterModels();
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({
      data: catalog.data.map(model => ({
        ...model,
        architecture: { ...model.architecture, input_modalities: ['text', 'pdf'] },
      })),
    });
    await expect(
      resolveEligibleFrontierFallback(sonnet, { ...context, ...request })
    ).resolves.toEqual({
      model: sonnet.model,
      reasoning: { enabled: true, effort: 'medium' },
      verbosity: 'medium',
    });
  });

  it.each([
    { type: 'input_file', filename: 'notes.txt', file_data: 'data:text/plain;base64,aGVsbG8=' },
    { type: 'input_file', filename: 'report.pdf', file_id: 'unverified-file' },
    { type: 'document', source: { type: 'base64', media_type: 'text/plain', data: 'aGVsbG8=' } },
  ])('rejects non-PDF or unverified files for a PDF-only fallback: %j', async file => {
    const catalog = await getEnhancedOpenRouterModels();
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({
      data: catalog.data.map(model => ({
        ...model,
        architecture: { ...model.architecture, input_modalities: ['text', 'pdf'] },
      })),
    });
    await expect(
      resolveEligibleFrontierFallback(sonnet, {
        ...context,
        body: { messages: [{ role: 'user', content: [file] }] },
      })
    ).resolves.toBeNull();
  });

  it('rejects requests exceeding model context', async () => {
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({
      data: [
        {
          id: sonnet.model,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          context_length: 1,
        },
      ],
    } as never);
    await expect(resolveEligibleFrontierFallback(sonnet, context)).resolves.toBeNull();
  });

  it('rejects an exclusive provider that cannot serve the API', async () => {
    jest
      .mocked(findKiloExclusiveModel)
      .mockReturnValue({ provider: { supportedChatApis: ['chat_completions'] } } as never);
    await expect(resolveEligibleFrontierFallback(sonnet, context)).resolves.toBeNull();
  });
});
