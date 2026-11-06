import { describe, expect, it, jest } from '@jest/globals';
import {
  MAX_ORGANIZATION_GROUP_MODEL_IDS,
  MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS,
  OrganizationGroupModelAccessPolicySchema,
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
});
