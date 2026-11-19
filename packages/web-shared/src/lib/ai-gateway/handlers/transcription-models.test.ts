import { beforeEach, describe, expect, test } from '@jest/globals';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas';
import { handleTranscriptionModelsRequest } from './transcription-models';
import { getOpenRouterTranscriptionModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  getEffectiveModelDecision,
  resolveOrganizationMemberModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  getOpenRouterTranscriptionModels: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    getEffectiveModelDecision: jest.fn(),
    resolveOrganizationMemberModelPolicy: jest.fn(),
  })
);

function makeModel(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: {
      input_modalities: ['audio'],
      output_modalities: ['text'],
      tokenizer: 'test',
    },
    top_provider: { is_moderated: false },
    pricing: { prompt: '0', completion: '0' },
    context_length: 0,
  };
}

const catalog = { data: [makeModel('openai/whisper-1'), makeModel('openai/gpt-4o-transcribe')] };

describe('GET /api/gateway/transcription-models', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(getOpenRouterTranscriptionModels).mockResolvedValue(catalog);
    jest.mocked(getUserFromAuth).mockResolvedValue({
      user: null,
      organizationId: null,
      authFailedResponse: null,
    } as never);
    jest.mocked(resolveOrganizationMemberModelPolicy).mockResolvedValue({} as never);
    jest.mocked(getEffectiveModelDecision).mockResolvedValue({ allowed: true });
  });

  test('returns the public catalog with `private, max-age=0, must-revalidate`', async () => {
    const response = await handleTranscriptionModelsRequest();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    await expect(response.json()).resolves.toEqual(catalog);
    expect(jest.mocked(resolveOrganizationMemberModelPolicy)).not.toHaveBeenCalled();
  });

  test('returns the member catalog with `private, no-store`', async () => {
    jest.mocked(getUserFromAuth).mockResolvedValue({
      user: { id: 'user-id' },
      organizationId: 'org-1',
      authFailedResponse: null,
    } as never);
    jest.mocked(getEffectiveModelDecision).mockImplementation(async (_policy, modelId) => ({
      allowed: modelId === 'openai/whisper-1',
    }));

    const response = await handleTranscriptionModelsRequest();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ data: [makeModel('openai/whisper-1')] });
    expect(jest.mocked(resolveOrganizationMemberModelPolicy).mock.calls[0]?.[0]).toEqual({
      organizationId: 'org-1',
      kiloUserId: 'user-id',
      fromDb: expect.anything(),
    });
  });
});
