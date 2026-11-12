import { beforeEach, describe, expect, test } from '@jest/globals';
import { handleEmbeddingModelsRequest } from './embedding-models';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getEffectiveModelDecision,
  resolveOrganizationMemberModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import {
  KILO_DEFAULT_EMBEDDING_MODEL,
  KILO_EMBEDDING_MODEL_CATALOG,
  getKiloEmbeddingModel,
  normalizeKiloEmbeddingModelId,
} from '@kilocode/web-shared/lib/ai-gateway/embeddings/kilo-embedding-models';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ readDb: {} }));
jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    getEffectiveModelDecision: jest.fn(),
    resolveOrganizationMemberModelPolicy: jest.fn(),
  })
);

const policy = {
  requireModelInCurrentSnapshot: false,
  organizationModelDenyList: [],
  memberGrant: { mode: 'unrestricted' },
  policyRevision: 1,
  customLlmGrantee: { organizationId: 'org-1', groupIds: [] },
} satisfies Awaited<ReturnType<typeof resolveOrganizationMemberModelPolicy>>;

function setOrganizationAllowedModels(modelIds: string[]) {
  jest.mocked(getUserFromAuth).mockResolvedValue({
    user: { id: 'user-1' },
    organizationId: 'org-1',
    authFailedResponse: null,
  } as Awaited<ReturnType<typeof getUserFromAuth>>);
  jest.mocked(getEffectiveModelDecision).mockImplementation(async (_policy, modelId) => ({
    allowed: modelIds.includes(modelId),
  }));
}

describe('GET /api/gateway/embedding-models', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(getUserFromAuth).mockRejectedValue(new Error('Unauthenticated'));
    jest.mocked(resolveOrganizationMemberModelPolicy).mockResolvedValue(policy);
  });

  test('returns the Kilo embedding model catalog', async () => {
    const response = await handleEmbeddingModelsRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(KILO_EMBEDDING_MODEL_CATALOG);
    expect(resolveOrganizationMemberModelPolicy).not.toHaveBeenCalled();
  });

  test('prefers the global OpenAI default when allowed by the organization', async () => {
    setOrganizationAllowedModels(KILO_EMBEDDING_MODEL_CATALOG.models.map(model => model.id));

    const response = await handleEmbeddingModelsRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(KILO_EMBEDDING_MODEL_CATALOG);
    expect(resolveOrganizationMemberModelPolicy).toHaveBeenCalledTimes(1);
    const [policyInput] = jest.mocked(resolveOrganizationMemberModelPolicy).mock.calls[0];
    expect(policyInput.organizationId).toBe('org-1');
    expect(policyInput.kiloUserId).toBe('user-1');
    expect(policyInput.fromDb === readDb).toBe(true);
    expect(getEffectiveModelDecision).toHaveBeenCalledTimes(
      KILO_EMBEDDING_MODEL_CATALOG.models.length
    );
  });

  test('preserves the legacy Mistral default when the organization blocks OpenAI', async () => {
    setOrganizationAllowedModels([
      'mistralai/codestral-embed-2505',
      'mistralai/mistral-embed-2312',
    ]);

    const response = await handleEmbeddingModelsRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      defaultModel: 'mistralai/mistral-embed-2312',
      models: [{ id: 'mistralai/codestral-embed-2505' }, { id: 'mistralai/mistral-embed-2312' }],
    });
  });

  test('uses the first allowed model when both preferred defaults are blocked', async () => {
    setOrganizationAllowedModels(['google/gemini-embedding-001', 'mistralai/codestral-embed-2505']);

    const response = await handleEmbeddingModelsRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      defaultModel: 'mistralai/codestral-embed-2505',
      models: [{ id: 'mistralai/codestral-embed-2505' }, { id: 'google/gemini-embedding-001' }],
    });
  });

  test('returns 409 when the organization has no allowed embedding models', async () => {
    setOrganizationAllowedModels([]);

    const response = await handleEmbeddingModelsRequest();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'No embedding models are available through your organization groups.',
    });
  });

  test('only returns aliases for allowed organization models', async () => {
    setOrganizationAllowedModels(['mistralai/mistral-embed-2312', 'baai/bge-m3']);

    const response = await handleEmbeddingModelsRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      defaultModel: 'mistralai/mistral-embed-2312',
      models: KILO_EMBEDDING_MODEL_CATALOG.models.filter(model =>
        ['mistralai/mistral-embed-2312', 'baai/bge-m3'].includes(model.id)
      ),
      aliases: { 'mistral-embed-2312': 'mistralai/mistral-embed-2312' },
    });
  });

  test('catalog includes default model metadata and aliases', () => {
    expect(KILO_DEFAULT_EMBEDDING_MODEL).toBe('openai/text-embedding-3-small');
    expect(KILO_EMBEDDING_MODEL_CATALOG.defaultModel).toBe('openai/text-embedding-3-small');
    expect(getKiloEmbeddingModel(KILO_DEFAULT_EMBEDDING_MODEL)).toEqual({
      id: 'openai/text-embedding-3-small',
      name: 'OpenAI Text Embedding 3 Small',
      dimension: 1536,
      scoreThreshold: 0.4,
    });
    expect(getKiloEmbeddingModel('codestral-embed-2505')).toMatchObject({
      id: 'mistralai/codestral-embed-2505',
      dimension: 1536,
      scoreThreshold: 0.35,
      dimensionMode: 'fixed',
    });
    expect(normalizeKiloEmbeddingModelId('mistral-embed-2312')).toBe(
      'mistralai/mistral-embed-2312'
    );
    expect(getKiloEmbeddingModel('mistral-embed-2312')).toEqual({
      id: 'mistralai/mistral-embed-2312',
      name: 'Mistral Embed 2312',
      dimension: 1024,
      scoreThreshold: 0.35,
      dimensionMode: 'fixed',
    });
    expect(normalizeKiloEmbeddingModelId('text-embedding-3-small')).toBe(
      'openai/text-embedding-3-small'
    );

    const modelIds = KILO_EMBEDDING_MODEL_CATALOG.models.map(model => model.id);
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(modelIds.filter(id => id === KILO_EMBEDDING_MODEL_CATALOG.defaultModel)).toHaveLength(1);
  });
});
