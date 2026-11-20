import { describe, expect, it, jest } from '@jest/globals';
import * as z from 'zod';
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

/** A selection whose every entry and count is at the documented maximum. */
function selectionAtLimits(entryCharacter: string) {
  return {
    type: 'model_access',
    data: {
      mode: 'selected',
      model_allow_list: Array.from({ length: MAX_ORGANIZATION_GROUP_MODEL_IDS }, () =>
        entryCharacter.repeat(MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH)
      ),
      provider_allow_list: Array.from({ length: MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS }, () =>
        entryCharacter.repeat(MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH)
      ),
    },
  } satisfies OrganizationGroupModelAccessPolicy;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The `description` of the `selected` mode member in a policy schema's JSON
 * Schema, reached without casts: the mode union sits behind `data`.
 */
function selectedMemberDescription(schema: z.ZodType): unknown {
  const json: unknown = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  if (!isJsonRecord(json) || !isJsonRecord(json.properties)) return undefined;
  const data = json.properties.data;
  if (!isJsonRecord(data) || !Array.isArray(data.oneOf)) return undefined;
  const member = data.oneOf.find(
    candidate =>
      isJsonRecord(candidate) &&
      isJsonRecord(candidate.properties) &&
      isJsonRecord(candidate.properties.mode) &&
      candidate.properties.mode.const === 'selected'
  );
  return isJsonRecord(member) ? member.description : undefined;
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
    if (result.success)
      throw new Error('Expected a provider slug above the documented maximum to fail');
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

  it('accepts the largest documented selection made of ASCII entries', () => {
    const policy = selectionAtLimits('m');

    expect(OrganizationGroupModelAccessPolicyWriteSchema.parse(policy)).toEqual(policy);
  });

  it('accepts the largest documented selection made of three-byte characters', () => {
    const policy = selectionAtLimits('\u20ac');
    const bytes = new TextEncoder().encode(JSON.stringify(policy.data)).length;

    expect(bytes).toBeLessThan(MAX_ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_BYTES);
    expect(OrganizationGroupModelAccessPolicyWriteSchema.parse(policy)).toEqual(policy);
  });

  it('requires a model id and a provider slug to be printable text', () => {
    const printablePolicy = {
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: ['vendor/model-1:free'],
        provider_allow_list: ['fixture-provider'],
      },
    } satisfies OrganizationGroupModelAccessPolicy;

    expect(OrganizationGroupModelAccessPolicyWriteSchema.parse(printablePolicy)).toEqual(
      printablePolicy
    );

    const modelPolicy = {
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: ['\u0001'.repeat(MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH)],
        provider_allow_list: [],
      },
    } satisfies OrganizationGroupModelAccessPolicy;

    const modelResult = OrganizationGroupModelAccessPolicyWriteSchema.safeParse(modelPolicy);

    expect(modelResult.success).toBe(false);
    if (modelResult.success) throw new Error('Expected a non-printable model id to be refused');
    expect(modelResult.error.issues).toEqual([
      expect.objectContaining({
        code: 'custom',
        message: 'Control characters are not allowed',
        path: ['data', 'model_allow_list', 0],
      }),
    ]);

    const providerPolicy = {
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: [],
        provider_allow_list: [`${'p'.repeat(30)}\u0001${'p'.repeat(30)}`],
      },
    } satisfies OrganizationGroupModelAccessPolicy;

    const providerResult = OrganizationGroupModelAccessPolicyWriteSchema.safeParse(providerPolicy);

    expect(providerResult.success).toBe(false);
    if (providerResult.success)
      throw new Error('Expected a non-printable provider slug to be refused');
    expect(providerResult.error.issues).toEqual([
      expect.objectContaining({
        code: 'custom',
        message: 'Control characters are not allowed',
        path: ['data', 'provider_allow_list', 0],
      }),
    ]);
  });

  it('documents the serialized size bound in the write schema JSON Schema but not the stored reader', () => {
    expect(selectedMemberDescription(OrganizationGroupModelAccessPolicyWriteSchema)).toBe(
      `Together the allow lists must serialize to at most ${MAX_ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_BYTES} bytes of UTF-8 JSON.`
    );
    expect(selectedMemberDescription(OrganizationGroupModelAccessPolicySchema)).toBeUndefined();
  });

  it('parses every policy mode through both schemas', () => {
    const policies = [
      { type: 'model_access', data: { mode: 'all' } },
      { type: 'model_access', data: { mode: 'none' } },
      selectedPolicy(1),
    ] satisfies OrganizationGroupModelAccessPolicy[];

    for (const policy of policies) {
      expect(OrganizationGroupModelAccessPolicySchema.parse(policy)).toEqual(policy);
      expect(OrganizationGroupModelAccessPolicyWriteSchema.parse(policy)).toEqual(policy);
    }
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

  it('parses every stored policy document the reader may hold', () => {
    const policy = {
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: ['vendor/\u0001model'],
        provider_allow_list: ['p\u0001p'],
      },
    } satisfies OrganizationGroupModelAccessPolicy;

    expect(OrganizationGroupModelAccessPolicySchema.parse(policy)).toEqual(policy);
  });
});
