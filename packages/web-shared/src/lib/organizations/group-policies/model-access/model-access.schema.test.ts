import { describe, expect, it, jest } from '@jest/globals';
import {
  MAX_ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_BYTES,
  MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH,
  MAX_ORGANIZATION_GROUP_MODEL_IDS,
  MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH,
  MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS,
  OrganizationGroupModelAccessPolicySchema,
  OrganizationGroupModelAccessPolicyWriteSchema,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.schema';
import {
  OrganizationGroupPoliciesSchema,
  type OrganizationGroupModelAccessPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies';
import { parseOrganizationGroupPolicies } from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies.server';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

function selectedPolicy(modelCount: number, providerCount = 0) {
  return {
    type: 'model_access',
    data: {
      mode: 'selected',
      model_allow_list: Array.from({ length: modelCount }, (_, index) => `vendor/model-${index}`),
      provider_allow_list: Array.from({ length: providerCount }, (_, index) => `provider-${index}`),
    },
  } satisfies OrganizationGroupModelAccessPolicy;
}

describe('model access policy catalog limits', () => {
  it('accepts a 607-model selection for policy writes and persisted reads', () => {
    const policy = selectedPolicy(607);

    expect(OrganizationGroupPoliciesSchema.parse([policy])).toEqual([policy]);
    expect(
      parseOrganizationGroupPolicies([policy], {
        organizationId: 'organization',
        groupId: 'group',
        source: 'group',
      })
    ).toEqual([policy]);
  });

  it('accepts a model selection at the maximum size', () => {
    const policy = selectedPolicy(MAX_ORGANIZATION_GROUP_MODEL_IDS);

    expect(OrganizationGroupModelAccessPolicySchema.parse(policy)).toEqual(policy);
  });

  it('rejects model selections above the maximum size', () => {
    const result = OrganizationGroupModelAccessPolicySchema.safeParse(
      selectedPolicy(MAX_ORGANIZATION_GROUP_MODEL_IDS + 1)
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected oversized model selection to fail');
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['data', 'model_allow_list'] }),
    ]);
  });

  it('preserves the provider maximum for selections with more than 500 models', () => {
    const policy = selectedPolicy(607, MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS);

    expect(OrganizationGroupModelAccessPolicySchema.parse(policy)).toEqual(policy);
  });

  it('rejects provider selections above the existing maximum size', () => {
    const result = OrganizationGroupModelAccessPolicySchema.safeParse(
      selectedPolicy(1, MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS + 1)
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected oversized provider selection to fail');
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['data', 'provider_allow_list'] }),
    ]);
  });

  it('accepts a model id of the documented maximum length', () => {
    const policy = {
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: ['m'.repeat(MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH)],
        provider_allow_list: [],
      },
    } satisfies OrganizationGroupModelAccessPolicy;

    expect(OrganizationGroupModelAccessPolicyWriteSchema.parse(policy)).toEqual(policy);
  });

  it('requires a model id to fit the documented maximum length', () => {
    const policy = {
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: ['m'.repeat(MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH + 1)],
        provider_allow_list: [],
      },
    } satisfies OrganizationGroupModelAccessPolicy;

    const result = OrganizationGroupModelAccessPolicyWriteSchema.safeParse(policy);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected a model id above the documented maximum to fail');
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['data', 'model_allow_list', 0] }),
    ]);
  });

  it('accepts a provider slug of the documented maximum length', () => {
    const policy = {
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: [],
        provider_allow_list: ['p'.repeat(MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH)],
      },
    } satisfies OrganizationGroupModelAccessPolicy;

    expect(OrganizationGroupModelAccessPolicyWriteSchema.parse(policy)).toEqual(policy);
  });

  it('requires a provider slug to fit the documented maximum length', () => {
    const policy = {
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: [],
        provider_allow_list: ['p'.repeat(MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH + 1)],
      },
    } satisfies OrganizationGroupModelAccessPolicy;

    const result = OrganizationGroupModelAccessPolicyWriteSchema.safeParse(policy);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected a provider slug above the documented maximum to fail');
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['data', 'provider_allow_list', 0] }),
    ]);
  });

  it('accepts a selection at the documented count limits', () => {
    const policy = selectedPolicy(
      MAX_ORGANIZATION_GROUP_MODEL_IDS,
      MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS
    );

    expect(OrganizationGroupModelAccessPolicyWriteSchema.parse(policy)).toEqual(policy);
  });

  it('requires a selection to fit the documented serialized size', () => {
    const policy = {
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: Array.from({ length: MAX_ORGANIZATION_GROUP_MODEL_IDS }, () =>
          'm'.repeat(MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH)
        ),
        provider_allow_list: Array.from({ length: MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS }, () =>
          'p'.repeat(MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH)
        ),
      },
    } satisfies OrganizationGroupModelAccessPolicy;
    expect(new TextEncoder().encode(JSON.stringify(policy.data)).length).toBeGreaterThan(
      MAX_ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_BYTES
    );

    const result = OrganizationGroupModelAccessPolicyWriteSchema.safeParse(policy);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected a selection above the documented size to fail');
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: 'custom', message: 'Policy too large', path: ['data'] }),
    ]);
  });

  it('parses a stored policy independently of the write bounds', () => {
    const policy = {
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: [`vendor/${'m'.repeat(MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH)}`],
        provider_allow_list: ['p'.repeat(MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH + 1)],
      },
    } satisfies OrganizationGroupModelAccessPolicy;

    expect(OrganizationGroupModelAccessPolicySchema.parse(policy)).toEqual(policy);
  });
});
