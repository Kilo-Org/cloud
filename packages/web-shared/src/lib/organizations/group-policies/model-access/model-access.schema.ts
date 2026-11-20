import type { OrganizationGroupModelAccessPolicy } from '@kilocode/db/schema-types';
import * as z from 'zod';

export const ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE = 'model_access';
export const MAX_ORGANIZATION_GROUP_MODEL_IDS = 2_000;
export const MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS = 500;
export const MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH = 200;
export const MAX_ORGANIZATION_GROUP_PROVIDER_SLUG_LENGTH = 64;
export const MAX_ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_BYTES = 2 * 1024 * 1024;
const utf8 = new TextEncoder();

/** An allow-list entry. A maximum length selects the bounded write entry. */
const modelIdEntry = (maxLength: number | undefined) => {
  const entry = z.string().trim().min(1);
  if (maxLength === undefined) return entry;
  return entry
    .max(maxLength)
    .refine(value => !/\p{Cc}/u.test(value), 'Control characters are not allowed');
};

const providerSlugEntry = (maxLength: number | undefined) => {
  const entry = z.string().trim().min(1);
  if (maxLength === undefined) return entry;
  return entry
    .max(maxLength)
    .refine(value => !/\p{Cc}/u.test(value), 'Control characters are not allowed');
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
        .array(modelIdEntry(bounds.modelIdLength))
        .max(MAX_ORGANIZATION_GROUP_MODEL_IDS),
      provider_allow_list: z
        .array(providerSlugEntry(bounds.providerSlugLength))
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
          .refine(data => utf8.encode(JSON.stringify(data)).length <= maxBytes, 'Policy too large')
          .describe(
            `Together the allow lists must serialize to at most ${maxBytes} bytes of UTF-8 JSON.`
          ),
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

export const DEFAULT_GROUP_MODEL_ACCESS_POLICY = {
  type: ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE,
  data: { mode: 'none' },
} satisfies OrganizationGroupModelAccessPolicy;

export const DEFAULT_ORGANIZATION_MODEL_ACCESS_POLICY = {
  type: ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE,
  data: { mode: 'all' },
} satisfies OrganizationGroupModelAccessPolicy;
