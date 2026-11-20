import type { OrganizationGroupModelAccessPolicy } from '@kilocode/db/schema-types';
import * as z from 'zod';

export const ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE = 'model_access';
export const MAX_ORGANIZATION_GROUP_MODEL_IDS = 2_000;
export const MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS = 500;
export const MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH = 200;
export const MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH = 64;
export const MAX_ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_BYTES = 2 * 1024 * 1024;
const utf8 = new TextEncoder();

/** The byte cap the write bounds attach, as the sentence a refused write reports. */
function serializedSizeBoundMessage(maxBytes: number): string {
  return `Together the allow lists must serialize to at most ${maxBytes} bytes of UTF-8 JSON.`;
}

/** The noun a refusal uses for one allow-list entry, by the list's issue-path segment. */
type AllowListNouns = { readonly singular: string; readonly plural: string };

const ALLOW_LIST_NOUNS: Readonly<Record<string, AllowListNouns>> = {
  model_allow_list: { singular: 'model id', plural: 'model ids' },
  provider_allow_list: { singular: 'provider slug', plural: 'provider slugs' },
};

function allowListNounsIn(path: readonly PropertyKey[]): AllowListNouns | undefined {
  for (const segment of path) {
    const nouns = ALLOW_LIST_NOUNS[String(segment)];
    if (nouns !== undefined) return nouns;
  }
  return undefined;
}

/**
 * An allow-list entry. A maximum length selects the bounded write entry, whose
 * refinements name the list they apply to; the stored reader passes no length.
 *
 * The write entry requires well-formed text because the policy is stored in a
 * `jsonb` column, and Postgres rejects a lone surrogate in JSON input with a
 * data exception rather than a validation error. Refusing it here keeps the
 * refusal a client error with a sentence that names the rule.
 */
const allowListEntry = (maxLength: number | undefined, nouns: AllowListNouns) => {
  const entry = z.string().trim().min(1);
  if (maxLength === undefined) return entry;
  return entry
    .max(maxLength)
    .refine(
      value => !/\p{Cc}/u.test(value),
      `A ${nouns.singular} must not contain control characters.`
    )
    .refine(value => value.isWellFormed(), `A ${nouns.singular} must be well-formed text.`);
};

/**
 * The `mode` union, built once per entry bound. The stored reader passes no
 * lengths, and the write schema passes the documented ones, so a mode added
 * here reaches both and neither can drift from the other.
 */
function modelAccessPolicyData(bounds: {
  modelIdLength?: number;
  providerSlugLength?: number;
  maxBytes?: number;
}) {
  const selected = z
    .object({
      mode: z.literal('selected'),
      model_allow_list: z
        .array(allowListEntry(bounds.modelIdLength, ALLOW_LIST_NOUNS.model_allow_list))
        .max(MAX_ORGANIZATION_GROUP_MODEL_IDS),
      provider_allow_list: z
        .array(allowListEntry(bounds.providerSlugLength, ALLOW_LIST_NOUNS.provider_allow_list))
        .max(MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS),
    })
    .strict();
  const maxBytes = bounds.maxBytes;
  return z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('all') }).strict(),
    z.object({ mode: z.literal('none') }).strict(),
    maxBytes === undefined
      ? selected
      : selected
          .refine(
            data => utf8.encode(JSON.stringify(data)).length <= maxBytes,
            serializedSizeBoundMessage(maxBytes)
          )
          .describe(serializedSizeBoundMessage(maxBytes)),
  ]);
}

/** The reader for a stored policy document. */
export const OrganizationGroupModelAccessPolicyDataSchema = modelAccessPolicyData({});

export const OrganizationGroupModelAccessPolicySchema = z
  .object({
    type: z.literal(ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE),
    data: OrganizationGroupModelAccessPolicyDataSchema,
  })
  .strict();

// Assert the runtime schema stays structurally compatible with the persisted
// database shape defined in `@kilocode/db`. `AssertTrue` is what makes drift a
// build error: a bare conditional type may legally resolve to `false`, and
// `never` would even satisfy `extends true`, so neither fails typecheck alone.
type AssertTrue<T extends true> = T;

export type _AssertModelAccessMatchesDb = AssertTrue<
  z.infer<
    typeof OrganizationGroupModelAccessPolicySchema
  > extends OrganizationGroupModelAccessPolicy
    ? OrganizationGroupModelAccessPolicy extends z.infer<
        typeof OrganizationGroupModelAccessPolicySchema
      >
      ? true
      : false
    : false
>;

/** The bounds a new policy document must satisfy. */
export const OrganizationGroupModelAccessPolicyWriteDataSchema = modelAccessPolicyData({
  modelIdLength: MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH,
  providerSlugLength: MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH,
  maxBytes: MAX_ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_BYTES,
});

export const OrganizationGroupModelAccessPolicyWriteSchema = z
  .object({
    type: z.literal(ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE),
    data: OrganizationGroupModelAccessPolicyWriteDataSchema,
  })
  .strict();

const INVALID_WRITE_MESSAGE = 'The organization model access policy is not valid.';

/**
 * The sentence a refused write reports. The bounds attach their constraint as
 * the message itself, so this names only the constraint a caller broke.
 */
export function describeModelAccessPolicyWriteRefusal(error: z.ZodError): string {
  for (const issue of error.issues) {
    if (issue.code === 'too_big') {
      const nouns = allowListNounsIn(issue.path);
      if (nouns === undefined) return INVALID_WRITE_MESSAGE;
      return Number.isInteger(issue.path[issue.path.length - 1])
        ? `Each ${nouns.singular} must be at most ${issue.maximum} characters long.`
        : `At most ${issue.maximum} ${nouns.plural} are allowed in one policy.`;
    }
    // Every custom issue in this schema carries a full sentence naming its bound.
    if (issue.code === 'custom') return issue.message;
    if (issue.code === 'too_small') {
      const nouns = allowListNounsIn(issue.path);
      return nouns === undefined
        ? INVALID_WRITE_MESSAGE
        : `Each ${nouns.singular} must not be empty.`;
    }
  }
  return INVALID_WRITE_MESSAGE;
}

export const DEFAULT_GROUP_MODEL_ACCESS_POLICY = {
  type: ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE,
  data: { mode: 'none' },
} satisfies OrganizationGroupModelAccessPolicy;

export const DEFAULT_ORGANIZATION_MODEL_ACCESS_POLICY = {
  type: ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE,
  data: { mode: 'all' },
} satisfies OrganizationGroupModelAccessPolicy;
