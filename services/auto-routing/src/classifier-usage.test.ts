import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MirrorPayload } from '@kilocode/auto-routing-contracts';
import { UsageRecordRequestSchema } from '@kilocode/usage-contracts';
import {
  buildClassifierUsage,
  recordClassifierUsage,
  writeClassifierUsage,
  type ClassifierUsageIdentity,
} from './classifier-usage';

const payload: MirrorPayload = {
  userId: 'user-1',
  organizationId: null,
  sessionId: 'session-1',
  machineId: 'machine-1',
  clientRequestId: 'client-request-1',
  mode: 'code',
  userAgent: 'test-client',
  bodyBytes: 42,
  input: {
    apiKind: 'chat_completions',
    requestedModel: 'kilo-auto/efficient',
    systemPromptPrefix: 'private system prompt',
    userPromptPrefix: 'private user prompt',
    latestUserPromptPrefix: null,
    messageCount: 1,
    hasTools: false,
    stream: true,
    providerHints: { provider: null, providerOptions: null },
  },
};
const identity: ClassifierUsageIdentity = {
  conversationKey: 'conversation-1',
  classifierModel: 'test/classifier',
  contentHash: 'exact-content-hash',
  kind: 'sync',
  requestStart: 'request-start-1',
};
const createdAt = '2026-01-01T00:00:00.000Z';
const costUsd = 0.000013;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classifier usage identity', () => {
  it('produces a stable UUID per call independently of delivery time', async () => {
    const first = await buildClassifierUsage(payload, identity, costUsd, createdAt);
    const retry = await buildClassifierUsage(
      payload,
      identity,
      costUsd,
      '2026-01-02T00:00:00.000Z'
    );
    expect(first.core.id).toBe(retry.core.id);
    expect(first.metadata.id).toBe(first.core.id);
    expect(UsageRecordRequestSchema.safeParse(first).success).toBe(true);
  });

  it.each([
    { conversationKey: 'conversation-2' },
    { classifierModel: 'other/classifier' },
    { contentHash: 'other-exact-hash' },
    { kind: 'background' as const },
    { kind: 'speculative' as const },
    { requestStart: 'request-start-2' },
  ])('separates calls when identity changes: %j', async change => {
    const first = await buildClassifierUsage(payload, identity, costUsd, createdAt);
    const other = await buildClassifierUsage(
      payload,
      { ...identity, ...change },
      costUsd,
      createdAt
    );
    expect(first.core.id).not.toBe(other.core.id);
  });

  it('matches classifier billing fields without persisting prompt text or lifecycle identity', async () => {
    const usage = await buildClassifierUsage(payload, identity, costUsd, createdAt);
    expect(usage.core).toMatchObject({
      kilo_user_id: payload.userId,
      model: 'auto-routing/classifier',
      requested_model: 'kilo-auto/efficient',
      provider: 'openrouter',
      cost: 13,
      input_tokens: 0,
      output_tokens: 0,
      organization_id: null,
      has_error: false,
    });
    expect(usage.metadata).toMatchObject({
      session_id: payload.sessionId,
      machine_id: payload.machineId,
      mode: payload.mode,
      is_byok: false,
      is_user_byok: false,
      streamed: false,
      has_tools: false,
      api_kind: payload.input.apiKind,
      user_prompt_prefix: '',
      system_prompt_prefix: '',
    });
    expect(usage.posthog_distinct_id).toBeNull();
    expect(JSON.stringify(usage)).not.toContain('private');
  });

  it('preserves the org payer and strips NUL bytes from client metadata', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000001';
    const usage = await buildClassifierUsage(
      {
        ...payload,
        organizationId,
        sessionId: 'session\u00001',
        machineId: 'machine\u00001',
        userAgent: 'client\u00001',
      },
      identity,
      costUsd,
      createdAt
    );
    expect(usage.core.organization_id).toBe(organizationId);
    expect(usage.metadata).toMatchObject({
      session_id: 'session1',
      machine_id: 'machine1',
      http_user_agent: 'client1',
      user_prompt_prefix: null,
      system_prompt_prefix: null,
    });
  });
});

describe('classifier usage delivery', () => {
  it.each(['sync', 'background', 'speculative'] as const)(
    'hands off one durable event for a %s call with no dependency on a decide response',
    async kind => {
      const record = vi.fn(async () => {});
      const env = {
        AUTO_ROUTING_DECISION_CACHE: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({ recordClassifierUsage: record })),
        },
      } as unknown as Env;
      await recordClassifierUsage(env, payload, { ...identity, kind }, costUsd, createdAt);
      const expected = await buildClassifierUsage(
        payload,
        { ...identity, kind },
        costUsd,
        createdAt
      );
      expect(record).toHaveBeenCalledExactlyOnceWith(expected);
      expect(env.AUTO_ROUTING_DECISION_CACHE.idFromName).toHaveBeenCalledExactlyOnceWith(
        identity.conversationKey
      );
    }
  );

  it('posts the usage contract to the existing web writer using the internal secret', async () => {
    const usage = await buildClassifierUsage(payload, identity, costUsd, createdAt);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: 'recorded',
        result: { usageId: usage.core.id, createdAt, newMicrodollarsUsed: 13 },
      })
    );
    const outcome = await writeClassifierUsage(
      {
        KILO_WEB_API_BASE_URL: 'https://web.example.test' as Env['KILO_WEB_API_BASE_URL'],
        INTERNAL_API_SECRET_PROD: { get: async () => 'test-internal-secret' } as SecretsStoreSecret,
      },
      usage
    );
    expect(outcome.kind).toBe('recorded');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://web.example.test/api/internal/usage/record',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'test-internal-secret',
        },
        body: JSON.stringify(usage),
      })
    );
  });

  it('returns unavailable when the secret cannot be read so the DO retains the event', async () => {
    const usage = await buildClassifierUsage(payload, identity, costUsd, createdAt);
    await expect(
      writeClassifierUsage(
        {
          KILO_WEB_API_BASE_URL: 'https://web.example.test' as Env['KILO_WEB_API_BASE_URL'],
          INTERNAL_API_SECRET_PROD: {
            get: async () => {
              throw new Error('secrets unavailable');
            },
          } as SecretsStoreSecret,
        },
        usage
      )
    ).resolves.toEqual({ kind: 'unavailable', reason: 'missing_config' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
