import { describe, expect, it } from '@jest/globals';
import {
  OrganizationGroupInputSchema,
  OrganizationGroupPoliciesSchema,
  OrganizationGroupPolicySchema,
} from '@/lib/organizations/group-policies/organization-group-policies';
import { normalizeOrganizationGroupPolicy } from './organization-groups';

const FIRST_CONFIG_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const SECOND_CONFIG_ID = '2f4f0e3a-1c1b-4a5d-9c2e-8b7a6d5c4e3f';

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

  it('validates the MCP server access discriminated union strictly', () => {
    expect(
      OrganizationGroupPolicySchema.safeParse({
        type: 'mcp_server_access',
        data: { mode: 'selected', config_ids: [FIRST_CONFIG_ID] },
      }).success
    ).toBe(true);
    expect(
      OrganizationGroupPolicySchema.safeParse({
        type: 'mcp_server_access',
        data: { mode: 'selected', config_ids: ['not-a-uuid'] },
      }).success
    ).toBe(false);
    expect(
      OrganizationGroupPolicySchema.safeParse({
        type: 'mcp_server_access',
        data: { mode: 'all', unknown: true },
      }).success
    ).toBe(false);
  });

  it('allows one policy per type in the same collection', () => {
    expect(
      OrganizationGroupPoliciesSchema.safeParse([
        { type: 'model_access', data: { mode: 'all' } },
        { type: 'mcp_server_access', data: { mode: 'none' } },
      ]).success
    ).toBe(true);
  });

  it('normalizes and deduplicates selected MCP server ids', () => {
    expect(
      normalizeOrganizationGroupPolicy({
        type: 'mcp_server_access',
        data: {
          mode: 'selected',
          config_ids: [SECOND_CONFIG_ID, FIRST_CONFIG_ID, FIRST_CONFIG_ID.toUpperCase()],
        },
      })
    ).toEqual({
      type: 'mcp_server_access',
      data: { mode: 'selected', config_ids: [FIRST_CONFIG_ID, SECOND_CONFIG_ID] },
    });
  });

  it('rejects duplicate policy discriminators', () => {
    expect(
      OrganizationGroupPoliciesSchema.safeParse([
        { type: 'model_access', data: { mode: 'all' } },
        { type: 'model_access', data: { mode: 'none' } },
      ]).success
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
