import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  getEmbeddingProvider,
  getTranscriptionProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import { createAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import {
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
  getBYOKforUser,
  getBYOKforOrganization,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import type { User } from '@kilocode/db/schema';
import { readDb } from '@kilocode/web-shared/lib/drizzle';

jest.mock('@kilocode/web-shared/lib/ai-gateway/byok');

const mockedGetModelInferenceUserByokProviders = getModelInferenceUserByokProviders as jest.Mock;
const mockedGetBYOKforUser = getBYOKforUser as jest.Mock;
const mockedGetBYOKforOrganization = getBYOKforOrganization as jest.Mock;

function createTestUser(overrides: Partial<User> = {}): User {
  return {
    id: 'test-user-id',
    google_user_email: 'test@example.com',
    microdollars_used: 0,
    total_microdollars_acquired: 1_000_000,
    is_admin: false,
    ...overrides,
  } as User;
}

describe('getEmbeddingProvider', () => {
  beforeEach(() => {
    mockedGetModelInferenceUserByokProviders.mockClear().mockResolvedValue([]);
    mockedGetBYOKforUser.mockClear().mockResolvedValue(null);
    mockedGetBYOKforOrganization.mockClear().mockResolvedValue(null);
  });

  it('should route all non-BYOK models to OpenRouter', async () => {
    const user = createTestUser();

    for (const model of [
      'mistralai/mistral-embed-2312',
      'openai/text-embedding-3-small',
      'google/text-embedding-004',
    ]) {
      const result = await getEmbeddingProvider(model, user, undefined);
      expect(result.provider.id).toBe('openrouter');
      expect(result.provider).toBe(OPENROUTER);
      expect(result.userByok).toBeNull();
    }
  });

  it('should route to Vercel AI Gateway when BYOK is available', async () => {
    const user = createTestUser();
    const mockByokResult = [{ decryptedAPIKey: 'sk-test', providerId: 'openai' as const }];

    mockedGetModelInferenceUserByokProviders.mockResolvedValue(['openai']);
    mockedGetBYOKforUser.mockResolvedValue(mockByokResult);

    const result = await getEmbeddingProvider('openai/text-embedding-3-small', user, undefined);

    expect(result.provider.id).toBe('vercel');
    expect(result.provider).toBe(VERCEL_AI_GATEWAY);
    expect(result.userByok).toEqual(mockByokResult);
    expect(mockedGetBYOKforUser).toHaveBeenCalledWith(readDb, user.id, ['openai']);
  });

  it('should check organization BYOK when organizationId is provided', async () => {
    const user = createTestUser();
    const mockByokResult = [{ decryptedAPIKey: 'sk-org', providerId: 'mistral' as const }];

    mockedGetModelInferenceUserByokProviders.mockResolvedValue(['mistral']);
    mockedGetBYOKforOrganization.mockResolvedValue(mockByokResult);

    const result = await getEmbeddingProvider('mistralai/mistral-embed-2312', user, 'org-123');

    expect(result.provider.id).toBe('vercel');
    expect(result.userByok).toEqual(mockByokResult);
    expect(mockedGetBYOKforOrganization).toHaveBeenCalledWith(readDb, 'org-123', ['mistral']);
  });

  it('should skip BYOK check for anonymous users', async () => {
    const anonUser = createAnonymousContext('127.0.0.1');
    const result = await getEmbeddingProvider('openai/text-embedding-3-small', anonUser, undefined);

    expect(result.provider.id).toBe('openrouter');
    expect(result.userByok).toBeNull();
    expect(mockedGetModelInferenceUserByokProviders).not.toHaveBeenCalled();
  });

  it('does not use gateway keys for embeddings', async () => {
    const user = createTestUser();
    mockedGetModelInferenceUserByokProviders.mockResolvedValue(['openai']);

    const result = await getEmbeddingProvider('openai/text-embedding-3-small', user, undefined);

    expect(result.provider).toBe(OPENROUTER);
    expect(result.userByok).toBeNull();
    expect(mockedGetBYOKforUser).toHaveBeenCalledWith(readDb, user.id, ['openai']);
    expect(getModelGatewayUserByokProviders).not.toHaveBeenCalled();
  });

  it('skips the key lookup when no inference provider serves the model', async () => {
    const result = await getEmbeddingProvider(
      'openai/text-embedding-3-small',
      createTestUser(),
      undefined
    );

    expect(result.provider).toBe(OPENROUTER);
    expect(mockedGetBYOKforUser).not.toHaveBeenCalled();
  });

  it('should fall through to OpenRouter when no BYOK keys found', async () => {
    const user = createTestUser();
    mockedGetModelInferenceUserByokProviders.mockResolvedValue(['openai']);
    mockedGetBYOKforUser.mockResolvedValue(null);

    const result = await getEmbeddingProvider('mistralai/codestral-embed-2505', user, undefined);

    expect(result.provider.id).toBe('openrouter');
    expect(result.userByok).toBeNull();
  });
});

describe('getTranscriptionProvider', () => {
  it('routes transcription requests to OpenRouter', async () => {
    const result = await getTranscriptionProvider();

    expect(result.provider).toBe(OPENROUTER);
    expect(result.userByok).toBeNull();
  });
});
