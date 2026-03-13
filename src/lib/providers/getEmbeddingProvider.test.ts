import { describe, it, expect, beforeEach } from '@jest/globals';
import { getEmbeddingProvider, PROVIDERS } from '@/lib/providers';
import { createAnonymousContext } from '@/lib/anonymous';
import { getModelUserByokProviders, getBYOKforUser, getBYOKforOrganization } from '@/lib/byok';
import type { User } from '@kilocode/db/schema';

jest.mock('@/lib/byok');

const mockedGetModelUserByokProviders = getModelUserByokProviders as jest.Mock;
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
    mockedGetModelUserByokProviders.mockClear().mockResolvedValue([]);
    mockedGetBYOKforUser.mockClear().mockResolvedValue(null);
    mockedGetBYOKforOrganization.mockClear().mockResolvedValue(null);
  });

  it('should route all non-BYOK models to PROVIDERS.OPENROUTER', async () => {
    const user = createTestUser();

    for (const model of [
      'mistralai/mistral-embed',
      'openai/text-embedding-3-small',
      'google/text-embedding-004',
    ]) {
      const result = await getEmbeddingProvider(model, user, undefined);
      expect(result.provider.id).toBe('openrouter');
      expect(result.provider).toBe(PROVIDERS.OPENROUTER);
      expect(result.userByok).toBeNull();
    }
  });

  it('should route to Vercel AI Gateway when BYOK is available', async () => {
    const user = createTestUser();
    const mockByokResult = [{ decryptedAPIKey: 'sk-test', providerId: 'openai' as const }];

    mockedGetModelUserByokProviders.mockResolvedValue(['openai']);
    mockedGetBYOKforUser.mockResolvedValue(mockByokResult);

    const result = await getEmbeddingProvider('openai/text-embedding-3-small', user, undefined);

    expect(result.provider.id).toBe('vercel');
    expect(result.provider).toBe(PROVIDERS.VERCEL_AI_GATEWAY);
    expect(result.userByok).toBe(mockByokResult);
  });

  it('should check organization BYOK when organizationId is provided', async () => {
    const user = createTestUser();
    const mockByokResult = [{ decryptedAPIKey: 'sk-org', providerId: 'mistral' as const }];

    mockedGetModelUserByokProviders.mockResolvedValue(['mistral']);
    mockedGetBYOKforOrganization.mockResolvedValue(mockByokResult);

    const result = await getEmbeddingProvider('mistralai/mistral-embed', user, 'org-123');

    expect(result.provider.id).toBe('vercel');
    expect(result.userByok).toBe(mockByokResult);
    expect(mockedGetBYOKforOrganization).toHaveBeenCalledWith(expect.anything(), 'org-123', [
      'mistral',
    ]);
  });

  it('should skip BYOK check for anonymous users', async () => {
    const anonUser = createAnonymousContext('127.0.0.1');
    const result = await getEmbeddingProvider('openai/text-embedding-3-small', anonUser, undefined);

    expect(result.provider.id).toBe('openrouter');
    expect(result.userByok).toBeNull();
    expect(mockedGetModelUserByokProviders).not.toHaveBeenCalled();
  });

  it('should fall through to OpenRouter when no BYOK keys found', async () => {
    const user = createTestUser();
    mockedGetModelUserByokProviders.mockResolvedValue(['openai']);
    mockedGetBYOKforUser.mockResolvedValue(null);

    const result = await getEmbeddingProvider('mistralai/codestral-embed-2505', user, undefined);

    expect(result.provider.id).toBe('openrouter');
    expect(result.userByok).toBeNull();
  });
});
