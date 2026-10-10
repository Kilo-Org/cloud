import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { countAndStoreUsage } from './processUsage';
import type { MicrodollarUsageContext } from './processUsage.types';
import type { ProviderId } from './providers/types';
import { getFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { FakeR2ClientModule } from '@kilocode/web-shared/tests/helpers/fake-r2.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

jest.mock('@kilocode/web-shared/lib/r2/create-client', () =>
  jest
    .requireActual<{
      createFakeR2ClientModule: () => FakeR2ClientModule;
    }>('@kilocode/web-shared/tests/helpers/fake-r2.helper')
    .createFakeR2ClientModule()
);

jest.mock('@kilocode/web-shared/lib/bouncer/client', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/bouncer/client'),
  reportUsageEvent: jest.fn(async () => undefined),
}));

const { fakeR2 } = jest.requireMock<FakeR2ClientModule>(
  '@kilocode/web-shared/lib/r2/create-client'
);

const BUCKET = 'test-vercel-provider-metadata';
Object.assign(process.env, {
  R2_VERCEL_PROVIDER_METADATA_BUCKET_NAME: BUCKET,
  R2_VERCEL_PROVIDER_METADATA_ACCESS_KEY_ID: 'test-access-key',
  R2_VERCEL_PROVIDER_METADATA_SECRET_ACCESS_KEY: 'test-secret-key',
});

const GENERATION_ID = 'gen_01KYMFY57BAFKZGK45197SCRGD';
const PROVIDER_METADATA = {
  fireworks: {},
  gateway: {
    routing: { canonicalSlug: 'moonshotai/kimi-k3-fast', finalProvider: 'fireworks' },
    cost: '0.0474822',
    marketCost: '0.0474822',
    generationId: GENERATION_ID,
    billableWebSearchCalls: 0,
  },
};

function vercelChatStream(providerMetadata: object | undefined) {
  const chunk = {
    id: GENERATION_ID,
    object: 'chat.completion.chunk',
    model: 'moonshotai/kimi-k3-fast',
    provider: 'fireworks',
    choices: [
      {
        index: 0,
        delta: { content: 'hi', provider_metadata: providerMetadata },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      cost: 0.0474822,
      is_byok: false,
    },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200 });
}

async function usageContext(provider: ProviderId): Promise<MicrodollarUsageContext> {
  const user = await insertTestUser();
  return {
    api_kind: 'chat_completions',
    kiloUserId: user.id,
    prior_microdollar_usage: user.microdollars_used,
    provider,
    fraudHeaders: getFraudDetectionHeaders(new Headers({ 'user-agent': 'test-agent' })),
    isStreaming: true,
    project_id: null,
    requested_model: 'moonshotai/kimi-k3-fast',
    promptInfo: { system_prompt_prefix: '', system_prompt_length: 0, user_prompt_prefix: '' },
    max_tokens: null,
    has_middle_out_transform: null,
    status_code: 200,
    editor_name: null,
    machine_id: null,
    user_byok: false,
    has_tools: false,
    feature: null,
    session_id: null,
    mode: null,
    auto_model: null,
    reasoning_setting: null,
    ttfb_ms: null,
  };
}

describe('countAndStoreUsage Vercel provider metadata storage', () => {
  beforeEach(() => {
    fakeR2.objects.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('stores the whole provider metadata of a Vercel response under its generation id', async () => {
    const record = await countAndStoreUsage(
      vercelChatStream(PROVIDER_METADATA),
      await usageContext('vercel'),
      undefined
    );

    expect(record).not.toBeNull();
    expect(fakeR2.objects.get(`${BUCKET}/${GENERATION_ID}.json`)).toBe(
      JSON.stringify(PROVIDER_METADATA)
    );
  });

  test('does not store anything for other providers', async () => {
    await countAndStoreUsage(
      vercelChatStream(PROVIDER_METADATA),
      await usageContext('openrouter'),
      undefined
    );

    expect(fakeR2.objects.size).toBe(0);
  });

  test('does not store anything when the response has no provider metadata', async () => {
    await countAndStoreUsage(vercelChatStream(undefined), await usageContext('vercel'), undefined);

    expect(fakeR2.objects.size).toBe(0);
  });

  test('still records usage when storing the metadata fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(fakeR2, 'send').mockRejectedValue(new Error('R2 unavailable'));

    const record = await countAndStoreUsage(
      vercelChatStream(PROVIDER_METADATA),
      await usageContext('vercel'),
      undefined
    );

    expect(record).not.toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      '[vercel-provider-metadata] failed to store metadata',
      expect.objectContaining({ generationId: GENERATION_ID })
    );
  });
});
