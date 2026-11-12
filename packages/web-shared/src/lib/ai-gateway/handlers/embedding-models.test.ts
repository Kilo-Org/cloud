import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextResponse } from 'next/server';
import { failureResult } from '@kilocode/web-shared/lib/maybe-result';
import { handleEmbeddingModelsRequest } from './embedding-models';
import {
  KILO_DEFAULT_EMBEDDING_MODEL,
  type KiloEmbeddingModelCatalog,
} from '@kilocode/web-shared/lib/ai-gateway/embeddings/kilo-embedding-models';
import { getKiloEmbeddingModelCatalogFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/embeddings/openrouter-embedding-models';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  getEffectiveModelDecision,
  resolveOrganizationMemberModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

jest.mock('@kilocode/web-shared/lib/ai-gateway/embeddings/openrouter-embedding-models', () => ({
  getKiloEmbeddingModelCatalogFromDatabase: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    getEffectiveModelDecision: jest.fn(),
    resolveOrganizationMemberModelPolicy: jest.fn(),
  })
);

const catalog = {
  defaultModel: KILO_DEFAULT_EMBEDDING_MODEL,
  models: [
    {
      id: KILO_DEFAULT_EMBEDDING_MODEL,
      name: 'Mistral Embed 2312',
      dimension: 1024,
      scoreThreshold: 0.35,
      dimensionMode: 'fixed',
    },
    {
      id: 'openai/text-embedding-3-small',
      name: 'OpenAI Text Embedding 3 Small',
      dimension: 1536,
      scoreThreshold: 0.4,
    },
    { id: 'new/embedding-model', name: 'New embedding model', scoreThreshold: 0.35 },
  ],
  aliases: {
    'mistral-embed-2312': KILO_DEFAULT_EMBEDDING_MODEL,
    'text-embedding-3-small': 'openai/text-embedding-3-small',
  },
} satisfies KiloEmbeddingModelCatalog;

const policy = {
  requireModelInCurrentSnapshot: false,
  organizationModelDenyList: [],
  memberGrant: { mode: 'unrestricted' },
  policyRevision: 1,
  customLlmGrantee: { organizationId: 'org-id', groupIds: [] },
} satisfies Awaited<ReturnType<typeof resolveOrganizationMemberModelPolicy>>;

describe('GET /api/v1/embedding-models', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(getKiloEmbeddingModelCatalogFromDatabase).mockResolvedValue(catalog);
    jest.mocked(getUserFromAuth).mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    });
    jest.mocked(resolveOrganizationMemberModelPolicy).mockResolvedValue(policy);
    jest.mocked(getEffectiveModelDecision).mockResolvedValue({ allowed: true });
  });

  test('returns the database catalog without an organization', async () => {
    const response = await handleEmbeddingModelsRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(catalog);
    expect(getUserFromAuth).toHaveBeenCalledWith({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
    expect(resolveOrganizationMemberModelPolicy).not.toHaveBeenCalled();
  });

  test('keeps the public catalog when optional authentication fails', async () => {
    jest.mocked(getUserFromAuth).mockRejectedValue(new Error('No authentication'));

    const response = await handleEmbeddingModelsRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(catalog);
  });

  test('returns a retryable unavailable response when no stored catalog exists', async () => {
    jest.mocked(getKiloEmbeddingModelCatalogFromDatabase).mockResolvedValue(null);

    const response = await handleEmbeddingModelsRequest();

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    await expect(response.json()).resolves.toEqual({
      error: 'Embedding model metadata is temporarily unavailable.',
    });
  });

  describe('organization policies', () => {
    beforeEach(() => {
      jest.mocked(getUserFromAuth).mockResolvedValue({
        user: { id: 'user-id' } as NonNullable<Awaited<ReturnType<typeof getUserFromAuth>>['user']>,
        organizationId: 'org-id',
        authFailedResponse: null,
      });
    });

    test('resolves policy once with readDb and checks every discovered model', async () => {
      const response = await handleEmbeddingModelsRequest();

      expect(resolveOrganizationMemberModelPolicy).toHaveBeenCalledTimes(1);
      const [policyInput] = jest.mocked(resolveOrganizationMemberModelPolicy).mock.calls[0];
      expect({
        organizationId: policyInput.organizationId,
        kiloUserId: policyInput.kiloUserId,
      }).toEqual({
        organizationId: 'org-id',
        kiloUserId: 'user-id',
      });
      expect(policyInput.fromDb === readDb).toBe(true);
      expect(jest.mocked(getEffectiveModelDecision).mock.calls).toEqual(
        catalog.models.map(model => [policy, model.id])
      );
      await expect(response.json()).resolves.toEqual(catalog);
    });

    test('filters denied models and aliases and selects the first allowed default', async () => {
      jest.mocked(getEffectiveModelDecision).mockImplementation(async (_policy, modelId) => ({
        allowed: modelId !== KILO_DEFAULT_EMBEDDING_MODEL,
      }));

      const response = await handleEmbeddingModelsRequest();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        defaultModel: 'openai/text-embedding-3-small',
        models: catalog.models.slice(1),
        aliases: { 'text-embedding-3-small': 'openai/text-embedding-3-small' },
      });
    });

    test('returns 409 when no discovered model is allowed', async () => {
      jest.mocked(getEffectiveModelDecision).mockResolvedValue({ allowed: false });

      const response = await handleEmbeddingModelsRequest();

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: 'No embedding models are available through your organization groups.',
      });
    });
  });
});
