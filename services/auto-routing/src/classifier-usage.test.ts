import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MirrorPayloadSchema, type MirrorPayload } from '@kilocode/auto-routing-contracts';
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
  scope: 'efficient',
  conversationKey: 'conversation-1',
  usageId: '00000000-0000-4000-8000-000000000001',
  requestedModel: 'kilo-auto/efficient',
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
  it('uses the pre-dispatch identity for reservation settlement metadata', () => {
    const usage = buildClassifierUsage(
      payload,
      { ...identity, prepaidReservationId: identity.usageId },
      costUsd,
      createdAt
    );
    expect(usage.core.id).toBe(identity.usageId);
    expect(usage.metadata.prepaid_reservation_id).toBe(identity.usageId);
    const unreservedUsage = buildClassifierUsage(payload, identity, costUsd, createdAt);
    expect(unreservedUsage.metadata.prepaid_reservation_id).toBeUndefined();
  });

  it('preserves the supplied UUID independently of delivery time', () => {
    const first = buildClassifierUsage(payload, identity, costUsd, createdAt);
    const retry = buildClassifierUsage(payload, identity, costUsd, '2026-01-02T00:00:00.000Z');
    expect(first.core.id).toBe(identity.usageId);
    expect(retry.core.id).toBe(identity.usageId);
    expect(first.metadata.id).toBe(first.core.id);
    expect(UsageRecordRequestSchema.safeParse(first).success).toBe(true);
  });

  it('keeps distinct operation IDs for otherwise identical usage', () => {
    const first = buildClassifierUsage(payload, identity, costUsd, createdAt);
    const other = buildClassifierUsage(
      payload,
      { ...identity, usageId: '00000000-0000-4000-8000-000000000002' },
      costUsd,
      createdAt
    );
    expect(first.core.id).not.toBe(other.core.id);
    expect(other.metadata.id).toBe(other.core.id);
  });

  it('bills a custom router call under the custom router model ID', () => {
    const usage = buildClassifierUsage(
      payload,
      { ...identity, scope: 'custom:router-1', requestedModel: 'kilo-auto/custom/org/team' },
      costUsd,
      createdAt
    );
    expect(usage.core.id).toBe(identity.usageId);
    expect(usage.core.requested_model).toBe('kilo-auto/custom/org/team');
    expect(usage.metadata.auto_model).toBe('kilo-auto/custom/org/team');
  });

  it('matches classifier billing fields without persisting prompt text or lifecycle identity', () => {
    const usage = buildClassifierUsage(payload, identity, costUsd, createdAt);
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

  it('maps an omitted organization to the same personal payer as the parsed payload', () => {
    const legacyPayload = { ...payload };
    Reflect.deleteProperty(legacyPayload, 'organizationId');
    const parsedPayload = MirrorPayloadSchema.parse(legacyPayload);
    expect(parsedPayload.organizationId).toBeNull();
    const legacyUsage = buildClassifierUsage(legacyPayload, identity, costUsd, createdAt);
    const parsedUsage = buildClassifierUsage(parsedPayload, identity, costUsd, createdAt);
    expect(legacyUsage.core.organization_id).toBeNull();
    expect(legacyUsage).toEqual(parsedUsage);
    expect(legacyUsage.core.cost).toBe(13);
  });

  it('preserves the org payer and strips NUL bytes from client metadata', () => {
    const organizationId = '00000000-0000-4000-8000-000000000001';
    const usage = buildClassifierUsage(
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
  it('hands off one durable event with no dependency on a decide response', async () => {
    const record = vi.fn(async () => {});
    const idFromName = vi.fn((name: string) => name);
    const env = {
      AUTO_ROUTING_DECISION_CACHE: {
        idFromName,
        get: vi.fn(() => ({ recordClassifierUsage: record })),
      },
    } as unknown as Env;
    await recordClassifierUsage(env, payload, identity, costUsd, createdAt);
    const expected = buildClassifierUsage(payload, identity, costUsd, createdAt);
    expect(record).toHaveBeenCalledExactlyOnceWith(expected);
    expect(idFromName).toHaveBeenCalledExactlyOnceWith(`efficient:${identity.conversationKey}`);
  });

  it('delivers usage through its scope-keyed conversation object', async () => {
    const record = vi.fn(async () => {});
    const idFromName = vi.fn((name: string) => name);
    const env = {
      AUTO_ROUTING_DECISION_CACHE: {
        idFromName,
        get: () => ({ recordClassifierUsage: record }),
      },
    } as unknown as Env;
    await recordClassifierUsage(
      env,
      payload,
      { ...identity, scope: 'custom:router-1' },
      costUsd,
      createdAt
    );
    expect(idFromName).toHaveBeenCalledExactlyOnceWith(
      `custom:router-1:${identity.conversationKey}`
    );
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('logs only the invalid field path and does not reject classifier usage recording', async () => {
    const record = vi.fn(async () => {});
    const env = {
      AUTO_ROUTING_DECISION_CACHE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ recordClassifierUsage: record })),
      },
    } as unknown as Env;
    const warnSpy = vi.mocked(console.warn);
    await expect(
      recordClassifierUsage(
        env,
        { ...payload, organizationId: 'private-invalid-org-id' },
        identity,
        costUsd,
        createdAt
      )
    ).resolves.toBeUndefined();
    expect(record).not.toHaveBeenCalled();
    expect(vi.mocked(env.AUTO_ROUTING_DECISION_CACHE).get.mock.calls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: 'auto_routing_classifier_usage_invalid',
        fieldPath: 'core.organization_id',
      })
    );
  });

  it('posts the usage contract to the existing web writer using the internal secret', async () => {
    const usage = buildClassifierUsage(payload, identity, costUsd, createdAt);
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
    const usage = buildClassifierUsage(payload, identity, costUsd, createdAt);
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
