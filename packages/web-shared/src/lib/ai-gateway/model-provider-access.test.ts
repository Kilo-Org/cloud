import { beforeEach, describe, expect, it } from '@jest/globals';
import { resolveModelProviderAccess } from '@kilocode/web-shared/lib/ai-gateway/model-provider-access';
import { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import {
  getEffectiveModelDecision,
  type EffectiveModelDecision,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    ...jest.requireActual<object>(
      '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server'
    ),
    getEffectiveModelDecision: jest.fn(),
  })
);

const MODEL = 'openai/gpt-5';
const policy = { policyRevision: 1 } as EffectiveOrganizationModelPolicy;
const noPrivacy = getEffectiveProviderPrivacy(undefined, undefined);

function decide(decision: EffectiveModelDecision) {
  jest.mocked(getEffectiveModelDecision).mockResolvedValue(decision);
}

function access(
  overrides: Partial<Parameters<typeof resolveModelProviderAccess>[0]> = {}
): ReturnType<typeof resolveModelProviderAccess> {
  return resolveModelProviderAccess({
    model: MODEL,
    groupPolicy: policy,
    settings: undefined,
    requestProvider: undefined,
    effectivePrivacy: noPrivacy,
    ...overrides,
  });
}

beforeEach(() => {
  jest.mocked(getEffectiveModelDecision).mockReset().mockResolvedValue({ allowed: true });
});

describe('resolveModelProviderAccess', () => {
  it('has no decision and no restrictions outside an organization policy', async () => {
    await expect(access({ groupPolicy: null })).resolves.toEqual({
      groupDecision: undefined,
      allowedProviders: undefined,
      effectiveProviderConfig: undefined,
      providerPreferencesExhausted: false,
    });
    expect(getEffectiveModelDecision).not.toHaveBeenCalled();
  });

  it('leaves the request’s provider settings alone when the policy and organization add none', async () => {
    decide({ allowed: true });

    await expect(access({ requestProvider: { only: ['openai'] } })).resolves.toEqual({
      groupDecision: { allowed: true },
      allowedProviders: undefined,
      effectiveProviderConfig: undefined,
      providerPreferencesExhausted: false,
    });
    expect(getEffectiveModelDecision).toHaveBeenCalledWith(policy, MODEL);
  });

  it('allows no provider for a model the policy denies', async () => {
    decide({ allowed: false, denialSource: 'organization_model' });

    const result = await access();

    expect(result.groupDecision).toEqual({ allowed: false, denialSource: 'organization_model' });
    expect(result.allowedProviders).toEqual(new Set());
    expect(result.providerPreferencesExhausted).toBe(false);
  });

  it('restricts the request to the policy’s eligible provider routes', async () => {
    decide({ allowed: true, eligibleProviderRoutes: new Set(['openai', 'anthropic']) });

    await expect(access()).resolves.toMatchObject({
      allowedProviders: new Set(['openai', 'anthropic']),
      effectiveProviderConfig: { only: ['openai', 'anthropic'] },
      providerPreferencesExhausted: false,
    });
  });

  it('intersects the request’s only list with the policy’s routes and drops its ignored providers', async () => {
    decide({ allowed: true, eligibleProviderRoutes: new Set(['openai', 'anthropic']) });

    await expect(
      access({ requestProvider: { only: ['openai', 'google-vertex'], data_collection: 'allow' } })
    ).resolves.toMatchObject({
      effectiveProviderConfig: { only: ['openai'], data_collection: 'allow' },
    });
    await expect(access({ requestProvider: { ignore: ['openai'] } })).resolves.toMatchObject({
      effectiveProviderConfig: { only: ['anthropic'], ignore: ['openai'] },
    });
  });

  it('is exhausted when the request and the policy share no provider', async () => {
    decide({ allowed: true, eligibleProviderRoutes: new Set(['openai']) });

    await expect(access({ requestProvider: { only: ['amazon-bedrock'] } })).resolves.toMatchObject({
      effectiveProviderConfig: undefined,
      providerPreferencesExhausted: true,
      allowedProviders: new Set(['openai']),
    });
  });

  it('applies the organization’s privacy to the request’s provider settings', async () => {
    decide({ allowed: true });
    const privacy = getEffectiveProviderPrivacy(undefined, 'deny');

    await expect(
      access({ settings: { data_collection: 'deny' }, effectivePrivacy: privacy })
    ).resolves.toMatchObject({
      effectiveProviderConfig: { data_collection: 'deny' },
      providerPreferencesExhausted: false,
    });
  });

  it('applies the organization’s privacy without a policy', async () => {
    await expect(
      access({
        groupPolicy: null,
        settings: { data_collection: 'deny' },
        effectivePrivacy: getEffectiveProviderPrivacy(undefined, 'deny'),
        requestProvider: { only: ['openai'] },
      })
    ).resolves.toMatchObject({
      groupDecision: undefined,
      effectiveProviderConfig: { only: ['openai'], data_collection: 'deny' },
    });
  });
});
