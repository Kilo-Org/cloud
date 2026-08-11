import { describe, expect, it } from '@jest/globals';
import {
  OrganizationGroupInputSchema,
  OrganizationGroupPoliciesSchema,
  OrganizationGroupPolicySchema,
  OrganizationGroupPolicyTargetSchema,
} from '@/lib/organizations/group-policies/organization-group-policies';
import { normalizeOrganizationGroupPolicy } from './organization-groups';

describe('organization group policies', () => {
  it('validates the model access discriminated union strictly', () => {
    expect(
      OrganizationGroupPolicySchema.safeParse({
        type: 'model_access',
        data: { mode: 'selected', model_allow_list: [], provider_allow_list: [] },
      }).success
    ).toBe(true);
    expect(OrganizationGroupPolicySchema.safeParse({ type: 'unknown' }).success).toBe(false);
    expect(
      OrganizationGroupPolicySchema.safeParse({
        type: 'model_access',
        data: { mode: 'all', unknown: true },
      }).success
    ).toBe(false);
  });

  it('rejects duplicate policy discriminators', () => {
    expect(
      OrganizationGroupPoliciesSchema.safeParse([
        { type: 'model_access', data: { mode: 'all' } },
        { type: 'model_access', data: { mode: 'none' } },
      ]).success
    ).toBe(false);
  });

  it('validates policy editor targets', () => {
    expect(OrganizationGroupPolicyTargetSchema.safeParse({ kind: 'default' }).success).toBe(true);
    expect(
      OrganizationGroupPolicyTargetSchema.safeParse({
        kind: 'group',
        groupId: '550e8400-e29b-41d4-a716-446655440000',
      }).success
    ).toBe(true);
    expect(
      OrganizationGroupPolicyTargetSchema.safeParse({ kind: 'group', groupId: 'not-a-uuid' })
        .success
    ).toBe(false);
  });

  it('validates group metadata limits', () => {
    expect(
      OrganizationGroupInputSchema.safeParse({ name: ' Engineering ', policies: [] }).success
    ).toBe(true);
    expect(OrganizationGroupInputSchema.safeParse({ name: ' ', policies: [] }).success).toBe(false);
    expect(
      OrganizationGroupInputSchema.safeParse({ name: 'a'.repeat(81), policies: [] }).success
    ).toBe(false);
    expect(
      OrganizationGroupInputSchema.safeParse({
        name: 'Engineering',
        description: 'a'.repeat(501),
        policies: [],
      }).success
    ).toBe(false);
  });

  it('normalizes and deduplicates selected model and provider values', () => {
    expect(
      normalizeOrganizationGroupPolicy({
        type: 'model_access',
        data: {
          mode: 'selected',
          model_allow_list: ['openai/gpt-4o:free', 'openai/gpt-4o'],
          provider_allow_list: ['OpenAI/model', 'openai'],
        },
      })
    ).toEqual({
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: ['openai/gpt-4o'],
        provider_allow_list: ['openai'],
      },
    });
  });
});
