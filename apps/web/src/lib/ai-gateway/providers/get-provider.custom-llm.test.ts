import type { User } from '@kilocode/db/schema';
import type { CustomLlmDefinition } from '@kilocode/db/schema-types';
import { readDb } from '@/lib/drizzle';
import { getProvider } from './get-provider';

jest.mock('@/lib/drizzle', () => ({
  readDb: { select: jest.fn() },
}));
jest.mock('@/lib/ai-gateway/byok', () => ({
  getBYOKforOrganization: jest.fn(),
  getBYOKforUser: jest.fn(),
  getModelUserByokProviders: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModel: jest.fn().mockResolvedValue({ provider: null, model: null }),
}));
jest.mock('@/lib/ai-gateway/providers/vercel', () => ({
  shouldRouteToVercel: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/lib/ai-gateway/experiments/membership', () => ({
  isPublicIdExperimented: jest.fn().mockResolvedValue(false),
}));

const mockedSelect = jest.mocked(readDb.select);

const customLlm: CustomLlmDefinition = {
  internal_id: 'upstream-model',
  display_name: 'Custom model',
  context_length: 128_000,
  max_completion_tokens: 8_192,
  base_url: 'https://example.com/v1',
  api_key: 'test-key',
  organization_ids: ['allowed-organization'],
  ip_allow_list: ['203.0.113.10'],
};

function mockCustomLlmRow() {
  mockedSelect.mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue([
        {
          public_id: 'kilo-internal/custom-model',
          definition: customLlm,
        },
      ]),
    }),
  } as never);
}

function providerInput(organizationId: string | undefined, clientIp: string | null) {
  return {
    requestedModel: 'kilo-internal/custom-model',
    request: {
      kind: 'chat_completions' as const,
      body: {
        model: 'kilo-internal/custom-model',
        messages: [{ role: 'user' as const, content: 'hello' }],
      },
    },
    user: { id: 'user-id' } as User,
    organizationId,
    taskId: undefined,
    clientIp,
    machineId: null,
  };
}

describe('getProvider custom LLM access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomLlmRow();
  });

  it('resolves the custom provider when organization and IP are allowed', async () => {
    const result = await getProvider(providerInput('allowed-organization', '203.0.113.10'));

    expect(result.kind).toBe('provider');
    if (result.kind === 'provider') {
      expect(result.provider.id).toBe('custom');
      expect(result.bypassAccessCheck).toBe(true);
    }
  });

  it('hard-denies a custom model when the client IP is not allowed', async () => {
    await expect(
      getProvider(providerInput('allowed-organization', '198.51.100.20'))
    ).resolves.toEqual({ kind: 'not-found' });
  });

  it('hard-denies a custom model without an organization', async () => {
    await expect(getProvider(providerInput(undefined, '203.0.113.10'))).resolves.toEqual({
      kind: 'not-found',
    });
    expect(mockedSelect).not.toHaveBeenCalled();
  });
});
