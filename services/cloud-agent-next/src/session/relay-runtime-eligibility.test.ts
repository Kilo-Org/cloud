import { describe, expect, it } from 'vitest';
import type { Env } from '../types.js';
import { projectTrpcErrorData } from '../trpc-error.js';
import type { SessionCreateRequest } from './session-requests.js';
import {
  isRelayRuntimeEligible,
  relayRuntimeIneligibleError,
} from './relay-runtime-eligibility.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const request: SessionCreateRequest = {
  chat: { transport: 'relay' },
  agent: { mode: 'code', model: 'fixture/model' },
  repository: { type: 'github', repo: 'fixture/repository' },
  options: { kilocodeOrganizationId: orgId, createdOnPlatform: 'cloud-agent-web' },
};
const context = (overrides: Partial<Env> = {}) => ({
  userId: 'fixture-user',
  env: {
    RUNTIME_KILO2_ORG_IDS: '*',
    RUNTIME_RELEASE_DESCRIPTOR_KILO2: 'synthetic-kilo2-release',
    ...overrides,
  } as Env,
});
const browser = { billingOrigin: 'cloud-agent-web' };

describe('relay runtime eligibility', () => {
  it.each(['cloud-agent', 'desktop', 'agent-manager', 'code-review', undefined])(
    'does not let relay or a client web label override trusted origin %s',
    billingOrigin => {
      expect(isRelayRuntimeEligible(request, context(), { billingOrigin })).toBe(false);
    }
  );

  it('uses resolved placement rather than assuming native or non-native rules', () => {
    const ctx = context({ RUNTIME_STARTUP_MODE: 'preinstalled' });
    expect(isRelayRuntimeEligible(request, ctx, browser)).toBe(false);
    expect(isRelayRuntimeEligible({ ...request, savedSandboxAllocation: null }, ctx, browser)).toBe(
      false
    );
    expect(
      isRelayRuntimeEligible({ ...request, savedSandboxAllocation: 'vercel-small' }, ctx, browser)
    ).toBe(true);
    expect(
      isRelayRuntimeEligible(
        { ...request, runtime: { sandboxAllocation: 'vercel-large' } },
        ctx,
        browser
      )
    ).toBe(true);
    expect(
      isRelayRuntimeEligible(
        { ...request, runtime: { sandboxAllocation: 'cloudflare-single' } },
        ctx,
        browser
      )
    ).toBe(false);
  });

  it.each([
    { RUNTIME_KILO2_ORG_IDS: '' },
    { RUNTIME_KILO2_ORG_IDS: '22222222-2222-4222-8222-222222222222' },
    { RUNTIME_KILO2_ORG_IDS: 'invalid-cohort' },
    { RUNTIME_RELEASE_DESCRIPTOR_KILO2: '' },
    { RUNTIME_INTERACTIVE_ORG_IDS: '*' },
    { NATIVE_RUNTIME_IMAGE: 'all-in-one' },
  ])('refuses incompatible tenant or startup facts: %j', overrides => {
    expect(isRelayRuntimeEligible(request, context(overrides), browser)).toBe(false);
  });

  it('accepts listed browser workspaces and preserves personal account scope', () => {
    const ctx = context({ RUNTIME_KILO2_ORG_IDS: orgId });
    expect(isRelayRuntimeEligible(request, ctx, browser)).toBe(true);
    expect(isRelayRuntimeEligible({ ...request, options: {} }, ctx, browser)).toBe(false);
    expect(isRelayRuntimeEligible({ ...request, options: {} }, context(), browser)).toBe(true);
  });

  it('checks the retained small-sandbox alias as its actual native containers placement', () => {
    expect(
      isRelayRuntimeEligible(
        {
          ...request,
          runtime: { sandboxAllocation: 'cloudflare-single' },
        },
        context(),
        browser
      )
    ).toBe(true);
  });

  it('leaves stream creation independent of relay startup configuration', () => {
    const ctx = context({
      RUNTIME_KILO2_ORG_IDS: 'invalid-cohort',
      NATIVE_RUNTIME_IMAGE: 'all-in-one',
    });
    expect(isRelayRuntimeEligible({ ...request, chat: undefined }, ctx)).toBe(true);
    expect(isRelayRuntimeEligible({ ...request, chat: { transport: 'stream' } }, ctx)).toBe(true);
  });

  it('projects the safe terminal client code through the actual tRPC error adapter', () => {
    const error = relayRuntimeIneligibleError();
    expect(
      projectTrpcErrorData({ code: error.code, httpStatus: 412 }, error.message, error.cause)
    ).toMatchObject({
      clientError: { code: 'RELAY_RUNTIME_INELIGIBLE', retryable: false },
      error: 'RELAY_RUNTIME_INELIGIBLE',
      retryable: false,
    });
  });
});
