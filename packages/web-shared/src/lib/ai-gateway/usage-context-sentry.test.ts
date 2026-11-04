import { describe, expect, it } from '@jest/globals';
import { GatewayApiKindSchema } from '@kilocode/usage-contracts';
import type { MicrodollarUsageContext } from './processUsage.types';
import { usageContextSentryExtra } from './usage-context-sentry';

const context: MicrodollarUsageContext & { futureSensitiveContextValue: string } = {
  api_kind: 'chat_completions',
  kiloUserId: 'sentry-kilo-user-fixture',
  fraudHeaders: {
    http_x_forwarded_for: '198.51.100.27',
    http_x_vercel_ip_city: 'sentry-private-city-fixture',
    http_x_vercel_ip_country: 'ZZ',
    http_x_vercel_ip_latitude: 12.34,
    http_x_vercel_ip_longitude: 56.78,
    http_x_vercel_ja4_digest: 'ja4-private-fingerprint-fixture',
    http_user_agent: 'private-user-agent-fixture',
  },
  organizationId: 'sentry-organization-fixture',
  provider: 'openrouter',
  requested_model: 'fixture/model',
  is_free: false,
  custom_llm_pricing: null,
  promptInfo: {
    system_prompt_prefix: 'SENSITIVE_ORGANIZATION_SYSTEM_PROMPT_FIXTURE',
    system_prompt_length: 44,
    user_prompt_prefix: 'SENSITIVE_USER_PROMPT_FIXTURE',
  },
  max_tokens: 256,
  has_middle_out_transform: false,
  isStreaming: false,
  prior_microdollar_usage: 100,
  posthog_distinct_id: 'sentry-private-fixture@example.com',
  project_id: 'sentry-project-fixture',
  status_code: null,
  editor_name: 'private-editor-fixture',
  machine_id: 'private-machine-fixture',
  user_byok: true,
  has_tools: false,
  feature: null,
  session_id: 'private-session-fixture',
  mode: 'private-mode-fixture',
  auto_model: null,
  reasoning_setting: 'private-reasoning-fixture',
  inference_region: null,
  ttfb_ms: null,
  clientRequestId: 'private-client-request-fixture',
  bouncer: {
    requestId: 'private-bouncer-request-fixture',
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    accountId: 'private-bouncer-account-fixture',
    clientIp: '203.0.113.58',
    clientAttributed: true,
    requestedLogprobs: false,
    samples: null,
    promptSimHash: 'private-prompt-simhash-fixture',
  },
  futureSensitiveContextValue: 'future-sensitive-context-fixture',
};

describe('usageContextSentryExtra', () => {
  it('returns only the explicit Sentry-safe allowlist', () => {
    const extra = usageContextSentryExtra({ ...context, usageId: 'synthetic-usage-id-fixture' });

    expect(extra).toStrictEqual({
      usageId: 'synthetic-usage-id-fixture',
      api_kind: 'chat_completions',
      provider: 'openrouter',
      requested_model: 'fixture/model',
      status_code: null,
      is_free: false,
      user_byok: true,
      organizationId: 'sentry-organization-fixture',
      kiloUserId: 'sentry-kilo-user-fixture',
    });
    expect(Object.keys(extra).sort()).toStrictEqual(
      [
        'usageId',
        'api_kind',
        'provider',
        'requested_model',
        'status_code',
        'is_free',
        'user_byok',
        'organizationId',
        'kiloUserId',
      ].sort()
    );
  });

  it('omits sensitive values and source-context keys when serialized', () => {
    const extra = usageContextSentryExtra(context);
    const serialized = JSON.stringify(extra);

    expect(extra.usageId).toBeUndefined();
    expect(extra.status_code).toBeNull();

    for (const value of [
      'sentry-private-fixture@example.com',
      '198.51.100.27',
      'sentry-private-city-fixture',
      'ja4-private-fingerprint-fixture',
      'private-user-agent-fixture',
      'SENSITIVE_ORGANIZATION_SYSTEM_PROMPT_FIXTURE',
      'SENSITIVE_USER_PROMPT_FIXTURE',
      '203.0.113.58',
      'private-prompt-simhash-fixture',
      'private-bouncer-request-fixture',
      'future-sensitive-context-fixture',
      'private-session-fixture',
      'private-client-request-fixture',
    ]) {
      expect(serialized).not.toContain(value);
    }

    for (const key of [
      'usageId',
      'fraudHeaders',
      'posthog_distinct_id',
      'promptInfo',
      'bouncer',
      'futureSensitiveContextValue',
      'http_x_forwarded_for',
      'http_x_vercel_ja4_digest',
      'system_prompt_prefix',
      'user_prompt_prefix',
      'clientIp',
      'promptSimHash',
      'session_id',
    ]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it.each(GatewayApiKindSchema.options)('preserves api_kind %s', api_kind => {
    expect(usageContextSentryExtra({ ...context, api_kind }).api_kind).toBe(api_kind);
  });
});
