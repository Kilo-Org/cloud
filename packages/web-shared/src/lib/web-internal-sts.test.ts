// Do not import `jest` from '@jest/globals': the SWC transform hoists these `jest.mock` calls only
// with the global `jest`.
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  INTERNAL_API_SECRET: 'env-internal-secret',
  // Read at each call, so a test sets the switch through `mockSenderAuth`.
  get WEB_INTERNAL_SENDER_AUTH() {
    return mockSenderAuth.value;
  },
}));
jest.mock('@kilocode/web-shared/lib/constants', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/constants'),
  APP_URL: 'https://app.example.com',
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/drizzle'),
  isUSRegion: () => true,
}));
jest.mock('@kilocode/web-shared/lib/sts-service-tokens', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/sts-service-tokens'),
  stsServiceToken: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureException: jest.fn(),
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { ServiceTokenError } from '@kilocode/service-token-client';
import type { EnkryptUsageWriteInput, UsageRecordRequest } from '@kilocode/usage-contracts';
import { getAuthoritativeClaudeBillingState } from './ai-gateway/claude-billing/payer-state';
import { recordEnkryptUsageInPrimaryRegion } from './ai-gateway/enkrypt-guardrail/usage-primary-region';
import { recordUsageInPrimaryRegion } from './ai-gateway/usage-record-client';
import { installInternalApiSecretRead } from './internal-api-secret';
import { stsServiceToken } from './sts-service-tokens';
import {
  STS_WEB_CLAUDE_BILLING_PAYER_STATE_READ,
  STS_WEB_USAGE_RECORD_REGION_HANDOFF,
  webInternalSenderCredential,
  webInternalSenderMode,
} from './web-internal-sts';

const mockSenderAuth: { value: string | undefined } = { value: undefined };
const mintedToken = jest.mocked(stsServiceToken);
const fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
const nativeFetch = globalThis.fetch;
const secretRead = jest.fn<Promise<string>, []>();

function sentHeaders(): Headers {
  return new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
}

beforeEach(() => {
  mockSenderAuth.value = undefined;
  mintedToken.mockReset();
  fetchMock.mockReset();
  secretRead.mockReset().mockResolvedValue('installed-internal-secret');
  installInternalApiSecretRead(secretRead);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.__kilocodeInternalApiSecretRead = undefined;
  globalThis.fetch = nativeFetch;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_TARGET_ENV;
  jest.restoreAllMocks();
});

describe('webInternalSenderMode', () => {
  it.each([
    [undefined, 'legacy'],
    ['', 'legacy'],
    ['legacy', 'legacy'],
    ['sts', 'sts'],
    ['STS', null],
    ['dual', null],
  ])('reads %p as %p', (value, mode) => {
    expect(webInternalSenderMode(value)).toBe(mode);
  });
});

describe('webInternalSenderCredential', () => {
  it('sends the legacy secret while WEB_INTERNAL_SENDER_AUTH is unset, without a mint', async () => {
    await expect(
      webInternalSenderCredential(STS_WEB_USAGE_RECORD_REGION_HANDOFF, { legacySecret: secretRead })
    ).resolves.toEqual({
      kind: 'ready',
      header: 'x-internal-api-key',
      value: 'installed-internal-secret',
    });
    expect(mintedToken).not.toHaveBeenCalled();
  });

  it('answers secret_missing for an empty legacy secret', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    secretRead.mockResolvedValue('');
    await expect(
      webInternalSenderCredential(STS_WEB_USAGE_RECORD_REGION_HANDOFF, { legacySecret: secretRead })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'secret_missing' });
  });

  it('mints from the deployment STS environment under sts and never reads the secret', async () => {
    mintedToken.mockResolvedValue('sts-token');
    await expect(
      webInternalSenderCredential(STS_WEB_CLAUDE_BILLING_PAYER_STATE_READ, {
        legacySecret: secretRead,
        auth: 'sts',
      })
    ).resolves.toEqual({ kind: 'ready', header: 'authorization', value: 'Bearer sts-token' });
    // Outside Vercel the deployment's STS environment is development.
    expect(mintedToken).toHaveBeenCalledWith('development', STS_WEB_CLAUDE_BILLING_PAYER_STATE_READ);
    expect(secretRead).not.toHaveBeenCalled();
  });

  it('sends nothing for an unknown switch value', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      webInternalSenderCredential(STS_WEB_USAGE_RECORD_REGION_HANDOFF, {
        legacySecret: secretRead,
        auth: 'dual',
      })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'auth_misconfigured' });
    expect(secretRead).not.toHaveBeenCalled();
    expect(mintedToken).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[web-internal-sts] no credential for a web internal route', {
      audience: 'web',
      scope: 'web:usage.region-handoff.record',
      reason: 'auth_misconfigured',
    });
  });

  it('sends nothing under sts on a deployment without an STS environment', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_TARGET_ENV = 'preview';
    await expect(
      webInternalSenderCredential(STS_WEB_USAGE_RECORD_REGION_HANDOFF, {
        legacySecret: secretRead,
        auth: 'sts',
      })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'no_sts_environment' });
    expect(mintedToken).not.toHaveBeenCalled();
    expect(secretRead).not.toHaveBeenCalled();
  });

  it('logs the closed reasons of a refused mint, never its message, and never falls back', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mintedToken.mockRejectedValue(
      new ServiceTokenError(
        { reason: 'denied', deniedReason: 'audience_not_allowed' },
        STS_WEB_USAGE_RECORD_REGION_HANDOFF
      )
    );
    await expect(
      webInternalSenderCredential(STS_WEB_USAGE_RECORD_REGION_HANDOFF, {
        legacySecret: secretRead,
        auth: 'sts',
      })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'token_unavailable' });
    expect(secretRead).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[web-internal-sts] no credential for a web internal route', {
      audience: 'web',
      scope: 'web:usage.region-handoff.record',
      reason: 'token_unavailable',
      failure: {
        errorName: 'ServiceTokenError',
        reason: 'denied',
        deniedReason: 'audience_not_allowed',
      },
    });
  });
});

describe('the US-region senders under WEB_INTERNAL_SENDER_AUTH=sts', () => {
  beforeEach(() => {
    mockSenderAuth.value = 'sts';
    mintedToken.mockResolvedValue('sts-handoff-token');
  });

  it('the usage-record handoff presents a web:usage.region-handoff.record token', async () => {
    const usageId = randomUUID();
    fetchMock.mockResolvedValue(
      Response.json({
        status: 'recorded',
        result: { usageId, createdAt: '2026-01-01T00:00:00.000Z', newMicrodollarsUsed: 1 },
      })
    );
    const outcome = await recordUsageInPrimaryRegion({
      core: { id: usageId },
      metadata: {},
      prior_microdollar_usage: 0,
      posthog_distinct_id: null,
    } as unknown as UsageRecordRequest);
    expect(outcome.kind).toBe('ok');
    expect(mintedToken).toHaveBeenCalledWith('development', STS_WEB_USAGE_RECORD_REGION_HANDOFF);
    expect(sentHeaders().get('authorization')).toBe('Bearer sts-handoff-token');
    expect(sentHeaders().has('x-internal-api-key')).toBe(false);
    expect(sentHeaders().get('x-usage-write-source')).toBe('region_handoff');
    expect(secretRead).not.toHaveBeenCalled();
  });

  it('the usage-record handoff writes locally without a request when no token is had', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mintedToken.mockRejectedValue(new Error('STS unreachable'));
    await expect(
      recordUsageInPrimaryRegion({ core: { id: randomUUID() } } as unknown as UsageRecordRequest)
    ).resolves.toEqual({ kind: 'unavailable', reason: 'credential_token_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(secretRead).not.toHaveBeenCalled();
  });

  it('the Enkrypt usage handoff presents a web:usage.region-handoff.record token', async () => {
    const id = randomUUID();
    fetchMock.mockResolvedValue(Response.json({ status: 'recorded', usageId: id }));
    await expect(
      recordEnkryptUsageInPrimaryRegion({ id } as unknown as EnkryptUsageWriteInput)
    ).resolves.toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL('https://app.example.com/api/internal/enkrypt-usage/record')
    );
    expect(mintedToken).toHaveBeenCalledWith('development', STS_WEB_USAGE_RECORD_REGION_HANDOFF);
    expect(sentHeaders().get('authorization')).toBe('Bearer sts-handoff-token');
    expect(sentHeaders().has('x-internal-api-key')).toBe(false);
    expect(secretRead).not.toHaveBeenCalled();
  });

  it('the Enkrypt usage handoff writes locally without a request when no token is had', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mintedToken.mockRejectedValue(new Error('STS unreachable'));
    const id = randomUUID();
    await expect(
      recordEnkryptUsageInPrimaryRegion({ id } as unknown as EnkryptUsageWriteInput)
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[enkrypt-guardrail] failed to record usage in the primary region; writing locally',
      { usage_id: id, reason: 'credential_token_unavailable' }
    );
  });

  it('the Claude payer-state read presents a web:claude-billing.payer-state.read token', async () => {
    mintedToken.mockResolvedValue('sts-payer-state-token');
    fetchMock.mockResolvedValue(Response.json({ connection: null }));
    await expect(
      getAuthoritativeClaudeBillingState({ kind: 'personal', kiloUserId: 'owner' })
    ).resolves.toBeNull();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://app.example.com/api/internal/claude-billing/payer-state'
    );
    expect(mintedToken).toHaveBeenCalledWith('development', STS_WEB_CLAUDE_BILLING_PAYER_STATE_READ);
    expect(sentHeaders().get('authorization')).toBe('Bearer sts-payer-state-token');
    expect(sentHeaders().has('x-internal-api-key')).toBe(false);
    expect(secretRead).not.toHaveBeenCalled();
  });

  it('the Claude payer-state read refuses without a request when no token is had', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mintedToken.mockRejectedValue(new Error('STS unreachable'));
    await expect(
      getAuthoritativeClaudeBillingState({ kind: 'personal', kiloUserId: 'owner' })
    ).rejects.toThrow('Claude payer-state authentication is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
