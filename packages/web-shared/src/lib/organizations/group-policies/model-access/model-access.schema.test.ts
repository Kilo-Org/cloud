import { describe, expect, it, jest } from '@jest/globals';
import * as z from 'zod';
import {
  describeModelAccessPolicyWriteRefusal,
  MAX_ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_BYTES,
  MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH,
  MAX_ORGANIZATION_GROUP_MODEL_IDS,
  MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH,
  MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS,
  modelAccessPolicyData,
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
        message: `A model id at index 0 ("${'\\u0001'.repeat(32)}…") must not contain control characters.`,
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
        message: `A provider slug at index 0 ("${'p'.repeat(30)}\\u0001p…") must not contain control characters.`,
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

  it('refuses an entry whose text is not well-formed, because the policy is stored as JSON', () => {
    const modelResult = OrganizationGroupModelAccessPolicyWriteSchema.safeParse({
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: ['vendor/m\uD800del'],
        provider_allow_list: [],
      },
    } satisfies OrganizationGroupModelAccessPolicy);

    expect(modelResult.success).toBe(false);
    if (modelResult.success) throw new Error('Expected a lone surrogate model id to be refused');
    expect(modelResult.error.issues).toEqual([
      expect.objectContaining({
        code: 'custom',
        path: ['data', 'model_allow_list', 0],
        message: 'A model id at index 0 ("vendor/m\\ud800del") must be well-formed text.',
      }),
    ]);

    const providerResult = OrganizationGroupModelAccessPolicyWriteSchema.safeParse({
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: [],
        provider_allow_list: ['p\uDC00p'],
      },
    } satisfies OrganizationGroupModelAccessPolicy);

    expect(providerResult.success).toBe(false);
    if (providerResult.success)
      throw new Error('Expected a lone surrogate provider slug to be refused');
    expect(providerResult.error.issues).toEqual([
      expect.objectContaining({
        code: 'custom',
        path: ['data', 'provider_allow_list', 0],
        message: 'A provider slug at index 0 ("p\\udc00p") must be well-formed text.',
      }),
    ]);
  });

  it('keeps the whole serialized size bound above every well-formed selection the entry bounds allow', () => {
    // The entry rules admit only printable, well-formed text, so the widest
    // entry is a three-byte character per UTF-16 unit. At the documented counts
    // and lengths that selection serializes below the bound, which therefore
    // never refuses a selection the entry rules accept.
    const policy = selectionAtLimits('\u20ac');
    const bytes = new TextEncoder().encode(JSON.stringify(policy.data)).length;

    expect(bytes).toBeLessThan(MAX_ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_BYTES);
    expect(OrganizationGroupModelAccessPolicyWriteSchema.parse(policy)).toEqual(policy);
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

describe('model access policy write refusal sentences', () => {
  function writeRefusal(policy: OrganizationGroupModelAccessPolicy): string {
    const result = OrganizationGroupModelAccessPolicyWriteSchema.safeParse(policy);
    if (result.success) throw new Error('Expected the write schema to refuse this policy');
    return describeModelAccessPolicyWriteRefusal(result.error);
  }

  it('names the model id length bound for an over-long model id', () => {
    expect(
      writeRefusal({
        type: 'model_access',
        data: {
          mode: 'selected',
          model_allow_list: ['m'.repeat(MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH + 1)],
          provider_allow_list: [],
        },
      })
    ).toBe(
      `A model id at index 0 ("${'m'.repeat(32)}…") must be at most ${MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH} characters long.`
    );
  });

  it('names the provider slug length bound for an over-long provider slug', () => {
    expect(
      writeRefusal({
        type: 'model_access',
        data: {
          mode: 'selected',
          model_allow_list: [],
          provider_allow_list: ['p'.repeat(MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH + 1)],
        },
      })
    ).toBe(
      `A provider slug at index 0 ("${'p'.repeat(32)}…") must be at most ${MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH} characters long.`
    );
  });

  it('names the model id count bound for a selection above it', () => {
    // The list-count rule authors the same sentence as the issue message, so a
    // caller reading `data.zodError` sees it without the mapper.
    const policy = selectedPolicy(MAX_ORGANIZATION_GROUP_MODEL_IDS + 1);
    const result = OrganizationGroupModelAccessPolicyWriteSchema.safeParse(policy);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an over-count selection to be refused');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        code: 'too_big',
        path: ['data', 'model_allow_list'],
        message: 'At most 2000 model ids are allowed in one policy.',
      }),
    ]);

    expect(writeRefusal(policy)).toBe('At most 2000 model ids are allowed in one policy.');
  });

  it('names the provider slug count bound for a selection above it', () => {
    expect(writeRefusal(selectedPolicy(1, MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS + 1))).toBe(
      'At most 500 provider slugs are allowed in one policy.'
    );
  });

  it('names the control character bound for a model id and a provider slug', () => {
    expect(
      writeRefusal({
        type: 'model_access',
        data: {
          mode: 'selected',
          model_allow_list: ['\u0001'.repeat(MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH)],
          provider_allow_list: [],
        },
      })
    ).toBe(
      `A model id at index 0 ("${'\\u0001'.repeat(32)}…") must not contain control characters.`
    );

    expect(
      writeRefusal({
        type: 'model_access',
        data: {
          mode: 'selected',
          model_allow_list: [],
          provider_allow_list: [`${'p'.repeat(30)}\u0001${'p'.repeat(30)}`],
        },
      })
    ).toBe(
      `A provider slug at index 0 ("${'p'.repeat(30)}\\u0001p…") must not contain control characters.`
    );
  });

  it('names the serialized size bound when the byte bound refuses the document', () => {
    // The entry rules set a maximum length and a maximum count, so the shipped
    // byte bound is a backstop. A builder with a small bound exercises the same
    // rule through a real parse.
    const bounds = {
      modelIdLength: MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH,
      providerSlugLength: MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH,
    };
    const data = {
      mode: 'selected',
      model_allow_list: Array.from({ length: 8 }, () =>
        'm'.repeat(MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH)
      ),
      provider_allow_list: [],
    };
    const sentence = 'Together the allow lists must serialize to at most 1024 bytes of UTF-8 JSON.';

    expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeGreaterThan(1024);

    const refused = modelAccessPolicyData({ ...bounds, maxBytes: 1024 }).safeParse(data);

    expect(refused.success).toBe(false);
    if (refused.success) throw new Error('Expected the byte bound to refuse this document');
    expect(refused.error.issues).toHaveLength(1);
    expect(refused.error.issues).toEqual([
      expect.objectContaining({ code: 'custom', message: sentence }),
    ]);
    expect(describeModelAccessPolicyWriteRefusal(refused.error)).toBe(sentence);

    expect(modelAccessPolicyData({ ...bounds, maxBytes: 4096 }).safeParse(data).success).toBe(true);
  });

  it('names the empty model id entry when a model id is blank', () => {
    expect(
      writeRefusal({
        type: 'model_access',
        data: { mode: 'selected', model_allow_list: [''], provider_allow_list: [] },
      })
    ).toBe('A model id at index 0 ("") must not be empty.');
  });

  it('names the empty provider slug entry when a provider slug is blank', () => {
    // `trim()` runs before the emptiness rule, so the sentence quotes the blank
    // entry as the empty string it became.
    expect(
      writeRefusal({
        type: 'model_access',
        data: { mode: 'selected', model_allow_list: [], provider_allow_list: ['  '] },
      })
    ).toBe('A provider slug at index 0 ("") must not be empty.');
  });

  it('names the index of an over-long model id beyond the first entry', () => {
    const sentence = writeRefusal({
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: [
          'vendor/one',
          'vendor/two',
          'vendor/three',
          'm'.repeat(MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH + 1),
        ],
        provider_allow_list: [],
      },
    });

    expect(sentence).toBe(
      `A model id at index 3 ("${'m'.repeat(32)}…") must be at most ${MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH} characters long.`
    );

    const excerpt = /at index 3 \("([^"]*)"\)/.exec(sentence)?.[1];
    expect(Array.from(excerpt ?? '')).toHaveLength(33);
    expect(excerpt?.endsWith('…')).toBe(true);
  });

  it('quotes a control character as an escape and names the provider slug index', () => {
    const sentence = writeRefusal({
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: [],
        provider_allow_list: ['provider-one', 'provider-two', 'p\u0002pp'],
      },
    });

    expect(sentence).toBe(
      'A provider slug at index 2 ("p\\u0002pp") must not contain control characters.'
    );
    expect(/\p{Cc}/u.test(sentence)).toBe(false);
  });

  it('keeps the sentence free of control characters for a C1 code point', () => {
    // U+0085 is `Cc` but outside the range `JSON.stringify` escapes.
    const sentence = writeRefusal({
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: [],
        provider_allow_list: ['p\u0085p'],
      },
    });

    expect(sentence).toBe(
      'A provider slug at index 0 ("p\\u0085p") must not contain control characters.'
    );
    expect(/\p{Cc}/u.test(sentence)).toBe(false);
    expect(sentence).toBe(sentence.normalize('NFKC'));
  });

  it('falls back to the generic refusal for a too_small issue outside the allow lists', () => {
    const result = z.string().min(1).safeParse('');
    if (result.success) throw new Error('Expected the schema to refuse the empty string');
    expect(describeModelAccessPolicyWriteRefusal(result.error)).toBe(
      'The organization model access policy is not valid.'
    );
  });
});
