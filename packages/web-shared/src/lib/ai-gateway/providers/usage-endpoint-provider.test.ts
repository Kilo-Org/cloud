import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  resolveTranscriptionRoute,
  resolveUsageEndpointRoute,
} from '@kilocode/web-shared/lib/ai-gateway/providers/usage-endpoint-provider';
import {
  getEmbeddingProvider,
  getTranscriptionProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import { createAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import {
  getModelInferenceUserByokProviders,
  getStoredByokKeys,
  type ByokKeyState,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import { getVercelModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import type { UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { User } from '@kilocode/db/schema';

jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/ai-gateway/byok'),
  getStoredByokKeys: jest.fn(),
  getModelInferenceUserByokProviders: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getVercelModelsMetadataFromDatabase: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel'
  ),
  mapModelIdToVercel: jest.fn(),
}));

const mockedGetModelInferenceUserByokProviders = jest.mocked(getModelInferenceUserByokProviders);
const mockedGetStoredByokKeys = jest.mocked(getStoredByokKeys);
const mockedGetVercelModelsMetadata = jest.mocked(getVercelModelsMetadataFromDatabase);
const mockedMapModelIdToVercel = jest.mocked(mapModelIdToVercel);

const model = 'mistralai/mistral-embed-2312';
const vercelModelId = 'mistral/mistral-embed-2312';
const freeModel = 'mistralai/mistral-embed-2312:free';
const user = { id: 'test-user-id' } as User;
const anonymous = createAnonymousContext('127.0.0.1');

function key(
  providerId: UserByokProviderId,
  options: { isEnabled?: boolean; priority?: number } = {}
): ByokKeyState {
  return {
    providerId,
    serveCatalogModels: false,
    isEnabled: options.isEnabled ?? true,
    ...options,
  };
}

/** Stores the owner's keys; a key decrypts to `sk-<providerId>`. */
function storeKeys(...keys: ByokKeyState[]) {
  const decrypt = jest.fn(async (providerId: UserByokProviderId) => ({
    decryptedAPIKey: `sk-${providerId}`,
    providerId,
  }));
  mockedGetStoredByokKeys.mockResolvedValue({ keys, decrypt });
  return decrypt;
}

function credential(providerId: UserByokProviderId) {
  return { decryptedAPIKey: `sk-${providerId}`, providerId };
}

/** Vercel lists these model ids with the given type. */
function vercelServes(type: string, ...ids: string[]) {
  mockedGetVercelModelsMetadata.mockResolvedValue(
    Object.fromEntries(ids.map(id => [id, { type }])) as never
  );
}

function resolveEmbedding(
  overrides: Partial<Parameters<typeof resolveUsageEndpointRoute>[0]> = {}
) {
  return resolveUsageEndpointRoute({
    requestedModel: model,
    modelType: 'embedding',
    user,
    organizationId: undefined,
    allowedProviders: undefined,
    openRouterDisabled: false,
    ...overrides,
  });
}

beforeEach(() => {
  mockedGetStoredByokKeys.mockReset();
  mockedGetModelInferenceUserByokProviders.mockReset().mockResolvedValue([]);
  mockedMapModelIdToVercel
    .mockReset()
    .mockImplementation(async id => (id === model ? vercelModelId : id));
  vercelServes('embedding');
  storeKeys();
});

describe('resolveUsageEndpointRoute', () => {
  describe('the owner’s OpenRouter key', () => {
    it('serves the model on the owner’s account', async () => {
      storeKeys(key('openrouter'));

      const route = await resolveEmbedding();

      expect(route.provider).toMatchObject({
        type: 'openrouter',
        apiUrl: OPENROUTER.apiUrl,
        apiKey: 'sk-openrouter',
      });
      expect(route.userByok).toEqual([credential('openrouter')]);
    });

    it('serves a model that no inference provider key or Vercel model serves', async () => {
      storeKeys(key('openrouter'));
      vercelServes('embedding');

      const route = await resolveEmbedding();

      expect(route.provider).toMatchObject({ type: 'openrouter', apiKey: 'sk-openrouter' });
    });

    it('is ignored when disabled', async () => {
      const decrypt = storeKeys(key('openrouter', { isEnabled: false }));

      const route = await resolveEmbedding();

      expect(route).toEqual({ provider: OPENROUTER, userByok: null });
      expect(decrypt).not.toHaveBeenCalled();
    });

    it('serves even when OpenRouter is disabled for Kilo’s account', async () => {
      storeKeys(key('openrouter'));
      vercelServes('embedding', vercelModelId);

      const route = await resolveEmbedding({ openRouterDisabled: true });

      expect(route.provider).toMatchObject({ type: 'openrouter', apiKey: 'sk-openrouter' });
      expect(route.userByok).toEqual([credential('openrouter')]);
    });
  });

  describe('the owner’s Vercel AI Gateway key', () => {
    it('serves a model Vercel lists with the endpoint’s model type', async () => {
      storeKeys(key('vercel-ai-gateway'));
      vercelServes('embedding', vercelModelId);

      const route = await resolveEmbedding();

      expect(route.provider).toMatchObject({
        type: 'vercel',
        apiUrl: VERCEL_AI_GATEWAY.apiUrl,
        apiKey: 'sk-vercel-ai-gateway',
      });
      expect(route.userByok).toEqual([credential('vercel-ai-gateway')]);
    });

    it('looks the model up under its mapped Vercel id', async () => {
      storeKeys(key('vercel-ai-gateway'));
      vercelServes('embedding', model);

      const route = await resolveEmbedding();

      expect(route).toEqual({ provider: OPENROUTER, userByok: null });
      expect(mockedMapModelIdToVercel).toHaveBeenCalledWith(model);
    });

    it.each([
      { label: 'does not list the model', metadata: {} },
      { label: 'lists the model with another type', metadata: { [vercelModelId]: 'language' } },
    ])('is skipped when Vercel $label', async ({ metadata }) => {
      const decrypt = storeKeys(key('vercel-ai-gateway'));
      mockedGetVercelModelsMetadata.mockResolvedValue(
        Object.fromEntries(Object.entries(metadata).map(([id, type]) => [id, { type }])) as never
      );

      const route = await resolveEmbedding();

      expect(route).toEqual({ provider: OPENROUTER, userByok: null });
      expect(decrypt).not.toHaveBeenCalled();
    });

    it.each([
      { modelType: 'embedding', vercelType: 'embedding', served: true },
      { modelType: 'embedding', vercelType: 'evaluation', served: false },
      { modelType: 'evaluation', vercelType: 'evaluation', served: true },
      { modelType: 'evaluation', vercelType: 'embedding', served: false },
    ] as const)(
      'serves a $modelType request only for a $vercelType Vercel model: $served',
      async ({ modelType, vercelType, served }) => {
        storeKeys(key('vercel-ai-gateway'));
        vercelServes(vercelType, vercelModelId);

        const route = await resolveEmbedding({ modelType });

        expect(route.provider.type).toBe(served ? 'vercel' : 'openrouter');
        expect(route.userByok === null).toBe(!served);
      }
    );

    it('falls through to the next key when Vercel does not serve the model', async () => {
      const decrypt = storeKeys(key('vercel-ai-gateway'), key('openrouter'));

      const route = await resolveEmbedding();

      expect(route.provider).toMatchObject({ type: 'openrouter', apiKey: 'sk-openrouter' });
      expect(route.userByok).toEqual([credential('openrouter')]);
      expect(decrypt.mock.calls).toEqual([['openrouter']]);
    });

    it('falls through to a key ranked after it when Vercel does not serve the model', async () => {
      mockedGetModelInferenceUserByokProviders.mockResolvedValue(['mistral']);
      storeKeys(
        key('vercel-ai-gateway', { priority: 0 }),
        key('mistral', { priority: 1 }),
        key('openrouter', { priority: 2 })
      );

      const route = await resolveEmbedding();

      expect(route.provider).toMatchObject({ type: 'openrouter', apiKey: 'sk-openrouter' });
    });

    it('takes precedence over the OpenRouter key by default when Vercel serves the model', async () => {
      storeKeys(key('openrouter'), key('vercel-ai-gateway'));
      vercelServes('embedding', vercelModelId);

      const route = await resolveEmbedding();

      expect(route.provider).toMatchObject({ type: 'vercel', apiKey: 'sk-vercel-ai-gateway' });
    });

    it('follows the owner’s priority over the default order', async () => {
      storeKeys(key('vercel-ai-gateway', { priority: 1 }), key('openrouter', { priority: 0 }));
      vercelServes('embedding', vercelModelId);

      const route = await resolveEmbedding();

      expect(route.provider).toMatchObject({ type: 'openrouter', apiKey: 'sk-openrouter' });
    });
  });

  describe('provider keys', () => {
    it('route through Kilo’s Vercel AI Gateway with every provider key', async () => {
      mockedGetModelInferenceUserByokProviders.mockResolvedValue(['mistral', 'codestral']);
      const decrypt = storeKeys(key('mistral'), key('codestral'), key('openrouter'));
      vercelServes('embedding', vercelModelId);

      const route = await resolveEmbedding();

      expect(route.provider).toBe(VERCEL_AI_GATEWAY);
      expect(route.userByok).toEqual([credential('mistral'), credential('codestral')]);
      expect(decrypt.mock.calls.map(([providerId]) => providerId).toSorted()).toEqual([
        'codestral',
        'mistral',
      ]);
    });

    it('never carry a gateway key', async () => {
      mockedGetModelInferenceUserByokProviders.mockResolvedValue(['mistral']);
      storeKeys(key('mistral'), key('vercel-ai-gateway'), key('openrouter'));
      vercelServes('embedding', vercelModelId);

      const route = await resolveEmbedding();

      expect(route.provider).toBe(VERCEL_AI_GATEWAY);
      expect(route.provider).not.toHaveProperty('apiKey', 'sk-vercel-ai-gateway');
      expect(route.userByok).toEqual([credential('mistral')]);
    });

    it('are ignored when disabled', async () => {
      mockedGetModelInferenceUserByokProviders.mockResolvedValue(['mistral', 'codestral']);
      storeKeys(key('mistral', { isEnabled: false }), key('codestral'));
      vercelServes('embedding', vercelModelId);

      const route = await resolveEmbedding();

      expect(route.provider).toBe(VERCEL_AI_GATEWAY);
      expect(route.userByok).toEqual([credential('codestral')]);
    });

    it('are skipped when Vercel does not list the mapped model with the endpoint type', async () => {
      mockedGetModelInferenceUserByokProviders.mockResolvedValue(['mistral']);
      storeKeys(key('mistral'));
      vercelServes('language', vercelModelId);

      expect(await resolveEmbedding()).toEqual({ provider: OPENROUTER, userByok: null });
    });

    it('are ignored when no inference provider of the model matches them', async () => {
      mockedGetModelInferenceUserByokProviders.mockResolvedValue(['mistral']);
      storeKeys(key('openai'));

      expect(await resolveEmbedding()).toEqual({ provider: OPENROUTER, userByok: null });
    });

    it('yield to a gateway key ranked before them', async () => {
      mockedGetModelInferenceUserByokProviders.mockResolvedValue(['mistral']);
      storeKeys(key('openrouter', { priority: 0 }), key('mistral', { priority: 1 }));

      const route = await resolveEmbedding();

      expect(route.provider).toMatchObject({ type: 'openrouter', apiKey: 'sk-openrouter' });
      expect(route.userByok).toEqual([credential('openrouter')]);
    });

    it('are limited to the providers the organization allows', async () => {
      mockedGetModelInferenceUserByokProviders.mockResolvedValue(['openai']);
      storeKeys(key('openai'));
      vercelServes('embedding', vercelModelId);

      const denied = await resolveEmbedding({ allowedProviders: new Set(['azure']) });
      expect(denied).toEqual({ provider: OPENROUTER, userByok: null });

      const allowed = await resolveEmbedding({ allowedProviders: new Set(['openai']) });
      expect(allowed.provider).toBe(VERCEL_AI_GATEWAY);
      expect(allowed.userByok).toEqual([credential('openai')]);
    });

    it('do not restrict the owner’s gateway keys', async () => {
      mockedGetModelInferenceUserByokProviders.mockResolvedValue(['openai']);
      storeKeys(key('openai'), key('openrouter'));

      const route = await resolveEmbedding({ allowedProviders: new Set(['azure']) });

      expect(route.provider).toMatchObject({ type: 'openrouter', apiKey: 'sk-openrouter' });
    });
  });

  describe('the owner', () => {
    it('is the user without an organization', async () => {
      storeKeys(key('openrouter'));

      await resolveEmbedding();

      expect(mockedGetStoredByokKeys).toHaveBeenCalledWith(expect.anything(), {
        type: 'user',
        id: user.id,
      });
    });

    it('is the organization for an organization request', async () => {
      storeKeys(key('openrouter'));

      await resolveEmbedding({ organizationId: 'org-123' });

      expect(mockedGetStoredByokKeys).toHaveBeenCalledWith(expect.anything(), {
        type: 'organization',
        id: 'org-123',
      });
    });
  });

  describe('free models', () => {
    it('never use a gateway key', async () => {
      const decrypt = storeKeys(key('vercel-ai-gateway'), key('openrouter'));
      vercelServes('embedding', freeModel);

      const route = await resolveEmbedding({ requestedModel: freeModel });

      expect(route).toEqual({ provider: OPENROUTER, userByok: null });
      expect(decrypt).not.toHaveBeenCalled();
      expect(mockedGetStoredByokKeys).not.toHaveBeenCalled();
    });

    it('stay on Kilo’s route when OpenRouter is disabled', async () => {
      storeKeys(key('openrouter'));
      vercelServes('embedding', freeModel);

      const route = await resolveEmbedding({ requestedModel: freeModel, openRouterDisabled: true });

      expect(route).toEqual({ provider: VERCEL_AI_GATEWAY, userByok: null });
    });
  });

  describe('Kilo’s route', () => {
    it('serves an anonymous caller without reading keys', async () => {
      storeKeys(key('openrouter'));

      const route = await resolveEmbedding({ user: anonymous });

      expect(route).toEqual({ provider: OPENROUTER, userByok: null });
      expect(mockedGetStoredByokKeys).not.toHaveBeenCalled();
    });

    it('runs through OpenRouter without keys', async () => {
      expect(await resolveEmbedding()).toEqual({ provider: OPENROUTER, userByok: null });
    });

    it('runs through OpenRouter when the keys are all disabled', async () => {
      storeKeys(
        key('openrouter', { isEnabled: false }),
        key('vercel-ai-gateway', { isEnabled: false })
      );
      vercelServes('embedding', vercelModelId);

      expect(await resolveEmbedding()).toEqual({ provider: OPENROUTER, userByok: null });
    });

    it('stays on OpenRouter when Vercel serves the model but OpenRouter is not disabled', async () => {
      vercelServes('embedding', vercelModelId);

      expect(await resolveEmbedding()).toEqual({ provider: OPENROUTER, userByok: null });
    });

    it('moves to Kilo’s Vercel AI Gateway when OpenRouter is disabled and Vercel serves the model', async () => {
      vercelServes('embedding', vercelModelId);

      const route = await resolveEmbedding({ openRouterDisabled: true });

      expect(route).toEqual({ provider: VERCEL_AI_GATEWAY, userByok: null });
    });

    it('moves to Kilo’s Vercel AI Gateway for an anonymous caller too', async () => {
      vercelServes('embedding', vercelModelId);

      const route = await resolveEmbedding({ user: anonymous, openRouterDisabled: true });

      expect(route).toEqual({ provider: VERCEL_AI_GATEWAY, userByok: null });
    });

    it.each([
      { label: 'does not list the model', metadata: {} },
      { label: 'lists the model with another type', metadata: { [vercelModelId]: 'language' } },
    ])(
      'stays on OpenRouter, for the gateway settings to refuse, when OpenRouter is disabled and Vercel $label',
      async ({ metadata }) => {
        mockedGetVercelModelsMetadata.mockResolvedValue(
          Object.fromEntries(Object.entries(metadata).map(([id, type]) => [id, { type }])) as never
        );

        const route = await resolveEmbedding({ openRouterDisabled: true });

        expect(route).toEqual({ provider: OPENROUTER, userByok: null });
      }
    );

    it('requires the endpoint’s model type when OpenRouter is disabled', async () => {
      vercelServes('embedding', vercelModelId);

      const route = await resolveEmbedding({ modelType: 'evaluation', openRouterDisabled: true });

      expect(route).toEqual({ provider: OPENROUTER, userByok: null });
    });
  });
});

describe('resolveTranscriptionRoute', () => {
  function resolveTranscription(
    overrides: Partial<Parameters<typeof resolveTranscriptionRoute>[0]> = {}
  ) {
    return resolveTranscriptionRoute({
      requestedModel: 'openai/whisper-1',
      user,
      organizationId: undefined,
      ...overrides,
    });
  }

  it('serves the request on the owner’s enabled OpenRouter key', async () => {
    storeKeys(key('vercel-ai-gateway'), key('openrouter'));

    const route = await resolveTranscription();

    expect(route.provider).toMatchObject({
      type: 'openrouter',
      apiUrl: OPENROUTER.apiUrl,
      apiKey: 'sk-openrouter',
    });
    expect(route.userByok).toEqual([credential('openrouter')]);
  });

  it('reads the organization’s keys for an organization request', async () => {
    storeKeys(key('openrouter'));

    await resolveTranscription({ organizationId: 'org-123' });

    expect(mockedGetStoredByokKeys).toHaveBeenCalledWith(expect.anything(), {
      type: 'organization',
      id: 'org-123',
    });
  });

  it.each([
    { label: 'no key', keys: [] },
    { label: 'a disabled OpenRouter key', keys: [key('openrouter', { isEnabled: false })] },
    { label: 'only other keys', keys: [key('vercel-ai-gateway'), key('openai'), key('mistral')] },
  ])('runs on Kilo’s OpenRouter account with $label', async ({ keys }) => {
    const decrypt = storeKeys(...keys);

    expect(await resolveTranscription()).toEqual({ provider: OPENROUTER, userByok: null });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('does not use a key for a free model', async () => {
    storeKeys(key('openrouter'));

    const route = await resolveTranscription({ requestedModel: 'openai/whisper-1:free' });

    expect(route).toEqual({ provider: OPENROUTER, userByok: null });
    expect(mockedGetStoredByokKeys).not.toHaveBeenCalled();
  });

  it('does not use a key for an anonymous caller', async () => {
    storeKeys(key('openrouter'));

    const route = await resolveTranscription({ user: anonymous });

    expect(route).toEqual({ provider: OPENROUTER, userByok: null });
    expect(mockedGetStoredByokKeys).not.toHaveBeenCalled();
  });
});

describe('getEmbeddingProvider', () => {
  it('reports whether the model is free next to the route', async () => {
    expect(await getEmbeddingProvider(model, user, undefined)).toEqual({
      provider: OPENROUTER,
      userByok: null,
      isFree: false,
    });
    expect(await getEmbeddingProvider(freeModel, user, undefined)).toEqual({
      provider: OPENROUTER,
      userByok: null,
      isFree: true,
    });
  });

  it('forwards the allowed providers and whether OpenRouter is disabled', async () => {
    mockedGetModelInferenceUserByokProviders.mockResolvedValue(['openai']);
    storeKeys(key('openai'));
    vercelServes('embedding', vercelModelId);

    const denied = await getEmbeddingProvider(model, user, 'org-123', {
      allowedProviders: new Set(['azure']),
      openRouterDisabled: true,
    });
    expect(denied).toEqual({ provider: VERCEL_AI_GATEWAY, userByok: null, isFree: false });

    const allowed = await getEmbeddingProvider(model, user, 'org-123', {
      allowedProviders: new Set(['openai']),
    });
    expect(allowed.provider).toBe(VERCEL_AI_GATEWAY);
    expect(allowed.userByok).toEqual([credential('openai')]);
  });
});

describe('getTranscriptionProvider', () => {
  it('serves a request on the owner’s OpenRouter key', async () => {
    storeKeys(key('openrouter'));

    const result = await getTranscriptionProvider({
      requestedModel: 'openai/whisper-1',
      user,
      organizationId: undefined,
    });

    expect(result.provider).toMatchObject({ type: 'openrouter', apiKey: 'sk-openrouter' });
    expect(result.userByok).toEqual([credential('openrouter')]);
  });

  it('falls back to Kilo’s OpenRouter account', async () => {
    const result = await getTranscriptionProvider({
      requestedModel: 'openai/whisper-1',
      user,
      organizationId: undefined,
    });

    expect(result).toEqual({ provider: OPENROUTER, userByok: null });
  });
});
