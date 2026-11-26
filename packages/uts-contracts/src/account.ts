import { z } from 'zod';
import { UtsAudienceSchema, UtsScopeSchema } from './token';

/**
 * The UTS account API for personal access tokens and org bot keys (design 5.3, 5.5, 5.8), the PAT
 * probe route, and the PAT lookup that verifiers call (design 7). Every route is on the issuer
 * origin. The account API takes a UTS access token for the `uts` audience that names its grant
 * (`sid`); a PAT is refused there, because a PAT names no session.
 */

/** RFC 9728 protected-resource metadata of the account API and the probe route. */
export const UTS_PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
export const UTS_PATS_PATH = '/account/pats';
/** `/account/orgs/<org id>/bot-keys`, and `/<key id>` and `/<key id>/keep` below it. */
export const UTS_ORGS_PATH = '/account/orgs';
/** Answers who the PAT in `Authorization: Bearer` belongs to; the PAT needs `uts:probe.read`. */
export const UTS_PAT_PROBE_PATH = '/probe/pat';

/** Design 5.3: a PAT and an org bot key live 90 days unless the request asks for less or more. */
export const UTS_CREDENTIAL_DEFAULT_LIFETIME_DAYS = 90;
/** Design 5.3: 1 year at most. */
export const UTS_CREDENTIAL_MAX_LIFETIME_DAYS = 365;

/** A credential name: 1 to 100 characters, no control characters. */
const CredentialNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  // eslint-disable-next-line no-control-regex -- the check is for control characters
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'no control characters');

const LifetimeDaysSchema = z.number().int().min(1).max(UTS_CREDENTIAL_MAX_LIFETIME_DAYS);
const TimeSchema = z.iso.datetime({ offset: true });

export const CreatePatRequestSchema = z.strictObject({
  name: CredentialNameSchema,
  scope: UtsScopeSchema,
  /** Days until expiry; 90 when absent. */
  expires_in_days: LifetimeDaysSchema.optional(),
  /** The organization the PAT is bound to, when it acts inside one. */
  org: z.uuid().optional(),
});
export type CreatePatRequest = z.infer<typeof CreatePatRequestSchema>;

const PatFieldsSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  audience: UtsAudienceSchema,
  scope: UtsScopeSchema,
  org: z.uuid().nullable(),
  /** The last four characters of the PAT, for display. */
  last_four: z.string().length(4),
  created_at: TimeSchema,
  expires_at: TimeSchema,
});

/** The answer to a create: the only time the PAT itself is shown. */
export const CreatedPatSchema = PatFieldsSchema.extend({ token: z.string().min(1) });
export type CreatedPat = z.infer<typeof CreatedPatSchema>;

export const PatSummarySchema = PatFieldsSchema.extend({ last_used_at: TimeSchema.nullable() });
export type PatSummary = z.infer<typeof PatSummarySchema>;

/** The caller's live PATs (unexpired and not revoked), newest first. */
export const PatListSchema = z.strictObject({ pats: z.array(PatSummarySchema) });
export type PatList = z.infer<typeof PatListSchema>;

export const CreateBotKeyRequestSchema = z.strictObject({
  name: CredentialNameSchema,
  scope: UtsScopeSchema,
  expires_in_days: LifetimeDaysSchema.optional(),
});
export type CreateBotKeyRequest = z.infer<typeof CreateBotKeyRequestSchema>;

const BotKeyFieldsSchema = z.strictObject({
  id: z.uuid(),
  org: z.uuid(),
  name: z.string().min(1),
  audience: UtsAudienceSchema,
  scope: UtsScopeSchema,
  last_four: z.string().length(4),
  /** The member who created the key; kept as history after that member leaves. */
  created_by: z.string().min(1),
  created_at: TimeSchema,
  expires_at: TimeSchema,
});

export const CreatedBotKeySchema = BotKeyFieldsSchema.extend({ token: z.string().min(1) });
export type CreatedBotKey = z.infer<typeof CreatedBotKeySchema>;

/**
 * A live bot key. A `flagged` key's creator left the organization; it stops at `stops_at`, 7 days
 * after it was flagged, unless an org admin keeps it (design 5.8).
 */
export const BotKeySummarySchema = z.discriminatedUnion('status', [
  BotKeyFieldsSchema.extend({
    status: z.literal('active'),
    last_used_at: TimeSchema.nullable(),
  }),
  BotKeyFieldsSchema.extend({
    status: z.literal('flagged'),
    last_used_at: TimeSchema.nullable(),
    flagged_at: TimeSchema,
    stops_at: TimeSchema,
  }),
  BotKeyFieldsSchema.extend({
    status: z.literal('kept'),
    last_used_at: TimeSchema.nullable(),
    flagged_at: TimeSchema,
    kept_by: z.string().min(1),
    kept_at: TimeSchema,
  }),
]);
export type BotKeySummary = z.infer<typeof BotKeySummarySchema>;

export const BotKeyListSchema = z.strictObject({ bot_keys: z.array(BotKeySummarySchema) });
export type BotKeyList = z.infer<typeof BotKeyListSchema>;

/** The probe route's answer for a live PAT. */
export const PatProbeResponseSchema = z.strictObject({
  sub: z.string().min(1),
  pat_id: z.uuid(),
  audience: UtsAudienceSchema,
  scope: UtsScopeSchema,
  org: z.uuid().nullable(),
});
export type PatProbeResponse = z.infer<typeof PatProbeResponseSchema>;

/**
 * The PAT lookup (design 7). A Worker verifier calls the mint Worker's named entrypoint
 * `UTS_PAT_LOOKUP_ENTRYPOINT` through a service binding whose `props.caller` names it; the mint
 * Worker answers only the callers it lists. The argument is the lowercase-hex SHA-256 of the whole
 * PAT; the answer is the same union as `PatLookupResult` of `@kilocode/verify`, and `not_found`
 * covers unknown, revoked and expired PATs and PATs of blocked accounts alike.
 */
export const UTS_PAT_LOOKUP_ENTRYPOINT = 'PatLookup';

export const PatHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** What UTS holds for a live PAT: one audience and one scope; `expiresAt` in seconds. */
export const UtsPatRecordSchema = z.strictObject({
  patId: z.string().min(1),
  subject: z.string().min(1),
  audience: UtsAudienceSchema,
  scope: UtsScopeSchema,
  org: z.string().min(1).nullable(),
  expiresAt: z.number().int().nonnegative(),
});
export type UtsPatRecord = z.infer<typeof UtsPatRecordSchema>;

export const UtsPatLookupResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('found'), record: UtsPatRecordSchema }),
  z.strictObject({ status: z.literal('not_found') }),
  z.strictObject({
    status: z.literal('rate_limited'),
    retryAfterSeconds: z.number().int().positive(),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    retryAfterSeconds: z.number().int().positive(),
  }),
]);
export type UtsPatLookupResult = z.infer<typeof UtsPatLookupResultSchema>;

/**
 * The `PatLookup` entrypoint as a verifier's binding exposes it. The result crosses a deploy
 * boundary, so the caller validates it with `UtsPatLookupResultSchema` and then disposes it.
 */
export type PatLookupBinding = { lookup(hash: string): Promise<unknown> };
