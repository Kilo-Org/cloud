import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { getProvider } from '@/lib/ai-gateway/providers/get-provider';
import { OPENROUTER, VERCEL_AI_GATEWAY } from '@/lib/ai-gateway/providers/provider-definitions';
import { shouldRouteToVercel } from '@/lib/ai-gateway/providers/vercel';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { User } from '@kilocode/db/schema';

jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModel: jest.fn().mockResolvedValue({ provider: null, model: null }),
}));
jest.mock('@/lib/ai-gateway/byok', () => ({
  getModelUserByokProviders: jest.fn().mockResolvedValue([]),
  getBYOKforUser: jest.fn(),
  getBYOKforOrganization: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/experiments/membership', () => ({
  isPublicIdExperimented: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/lib/ai-gateway/providers/vercel', () => ({
  shouldRouteToVercel: jest.fn().mockResolvedValue(false),
}));

const request = {
  kind: 'chat_completions',
  body: { model: 'fake-deterministic', messages: [] },
} as GatewayRequest;

const user = { id: 'user-id' } as User;

function providerInput(requestedModel: string) {
  return {
    requestedModel,
    request,
    user,
    organizationId: undefined,
    taskId: undefined,
    clientIp: null,
    machineId: null,
  };
}

function replaceEnv(overrides: {
  NODE_ENV?: NodeJS.ProcessEnv['NODE_ENV'];
  FAKE_LLM_URL?: string;
  VERCEL?: string;
}) {
  const nextEnv = { ...process.env, ...overrides };
  if (!('VERCEL' in overrides)) {
    delete nextEnv.VERCEL;
  }
  if (!('FAKE_LLM_URL' in overrides)) {
    delete nextEnv.FAKE_LLM_URL;
  }
  return jest.replaceProperty(process, 'env', nextEnv as NodeJS.ProcessEnv);
}

describe('getProvider local fake deterministic routing', () => {
  beforeEach(() => {
    jest.mocked(shouldRouteToVercel).mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('routes fake-deterministic to FAKE_LLM_URL when enabled', async () => {
    const env = replaceEnv({ NODE_ENV: 'development', FAKE_LLM_URL: 'http://localhost:8811' });

    const result = await getProvider(providerInput('fake-deterministic'));
    expect(result).toMatchObject({
      kind: 'provider',
      bypassAccessCheck: true,
      userByok: null,
      provider: {
        id: 'custom',
        apiUrl: 'http://localhost:8811/api/openrouter',
      },
    });

    const prefixed = await getProvider(providerInput('kilo/fake-deterministic'));
    expect(prefixed.kind === 'provider' && prefixed.provider.apiUrl).toBe(
      'http://localhost:8811/api/openrouter'
    );
    env.restore();
  });

  test('does not route fake-deterministic when disabled, on Vercel, or without a URL', async () => {
    const disabled = await getProvider(providerInput('fake-deterministic'));
    expect(disabled).toEqual({
      kind: 'provider',
      provider: OPENROUTER,
      userByok: null,
      bypassAccessCheck: false,
    });

    const vercel = replaceEnv({
      NODE_ENV: 'development',
      FAKE_LLM_URL: 'http://localhost:8811',
      VERCEL: '1',
    });
    expect(await getProvider(providerInput('fake-deterministic'))).toEqual({
      kind: 'provider',
      provider: OPENROUTER,
      userByok: null,
      bypassAccessCheck: false,
    });
    vercel.restore();

    const missingUrl = replaceEnv({ NODE_ENV: 'development' });
    expect(await getProvider(providerInput('fake-deterministic'))).toEqual({
      kind: 'provider',
      provider: OPENROUTER,
      userByok: null,
      bypassAccessCheck: false,
    });
    missingUrl.restore();
  });

  test('routes MiniMax M3 through its declared OpenRouter gateway regardless of Vercel routing', async () => {
    jest.mocked(shouldRouteToVercel).mockResolvedValue(true);

    expect(await getProvider(providerInput('minimax/minimax-m3:free'))).toEqual({
      kind: 'provider',
      provider: OPENROUTER,
      userByok: null,
      bypassAccessCheck: false,
    });
    expect(shouldRouteToVercel).not.toHaveBeenCalled();
  });

  test('routes MiniMax M2.7 through its declared Vercel AI Gateway', async () => {
    expect(await getProvider(providerInput('minimax/minimax-m2.7:free'))).toEqual({
      kind: 'provider',
      provider: VERCEL_AI_GATEWAY,
      userByok: null,
      bypassAccessCheck: false,
    });
  });
});
