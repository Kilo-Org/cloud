import {
  type BotKeySummary,
  BotKeySummarySchema,
  type PatSummary,
  PatSummarySchema,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { IdentityStore } from '../db/client';
import { type FeedEntry, StatementFeedEntriesSchema } from '../revocation/entries';

/**
 * The account API statements (migrations 0005 and 0025). Each call is one SQL statement: a
 * SECURITY DEFINER function that checks the caller's session, runs the gate where the action has
 * one, and writes the credential, the gate pass, the notice and the audit row together. Results
 * arrive as one row whose `outcome` column picks the shape.
 */

/**
 * The caller: the access token's subject, and the session its `sid` names (a CLI grant, or a
 * `kilo-web` browser session), which the statements match to that subject.
 */
export type AccountSession = { accountId: string; grantId: string };

export type CreatePatInput = AccountSession & {
  environment: UtsEnvironment;
  name: string;
  tokenHash: Uint8Array;
  lastFour: string;
  scope: string;
  orgId: string | null;
  lifetimeDays: number;
};
export type CreatedCredential = { id: string; createdAt: Date; expiresAt: Date };
/**
 * `gate_required`: no sign-in and no passkey step-up within 10 minutes (design 5.11).
 * `org_denied`: the PAT names an organization the caller cannot act in.
 * `rate_limited`: the account created 20 PATs in the last hour (migration 0019).
 */
export type CreatePatResult =
  | ({ outcome: 'created' } & CreatedCredential)
  | {
      outcome:
        | 'invalid_session'
        | 'gate_required'
        | 'org_denied'
        | 'limit_reached'
        | 'rate_limited';
    };

export type ListPatsResult =
  | { outcome: 'listed'; pats: PatSummary[] }
  | { outcome: 'invalid_session' };

export type RevokePatInput = AccountSession & { environment: UtsEnvironment; patId: string };
export type RevokeOutcome = 'revoked' | 'already_revoked' | 'not_found' | 'invalid_session';
/**
 * The outcome and the feed entries the statement wrote (one for `revoked`, none otherwise), which
 * the caller publishes to the feed objects (design 5.6).
 */
export type RevokeResult = { outcome: RevokeOutcome; feedEntries: FeedEntry[] };

type OrgSession = AccountSession & { orgId: string };

export type CreateBotKeyInput = OrgSession & {
  environment: UtsEnvironment;
  name: string;
  tokenHash: Uint8Array;
  lastFour: string;
  scope: string;
  lifetimeDays: number;
};
export type CreateBotKeyResult =
  | ({ outcome: 'created' } & CreatedCredential)
  | {
      outcome:
        | 'invalid_session'
        | 'gate_required'
        | 'not_org_admin'
        | 'limit_reached'
        | 'rate_limited';
    };

export type ListBotKeysResult =
  | { outcome: 'listed'; botKeys: BotKeySummary[] }
  | { outcome: 'invalid_session' | 'not_org_admin' };

export type BotKeyActionInput = OrgSession & { environment: UtsEnvironment; keyId: string };
export type RevokeBotKeyResult = {
  outcome: RevokeOutcome | 'not_org_admin';
  feedEntries: FeedEntry[];
};
export type KeepBotKeyResult =
  | 'kept'
  | 'not_flagged'
  | 'lapsed'
  | 'not_found'
  | 'invalid_session'
  | 'not_org_admin'
  /** Keeping a key passes the tier B gate, as a create does. */
  | 'gate_required';

export type AccountStore = {
  createPat(input: CreatePatInput): Promise<CreatePatResult>;
  listPats(session: AccountSession): Promise<ListPatsResult>;
  revokePat(input: RevokePatInput): Promise<RevokeResult>;
  createBotKey(input: CreateBotKeyInput): Promise<CreateBotKeyResult>;
  listBotKeys(session: OrgSession): Promise<ListBotKeysResult>;
  revokeBotKey(input: BotKeyActionInput): Promise<RevokeBotKeyResult>;
  keepBotKey(input: BotKeyActionInput): Promise<KeepBotKeyResult>;
};

/** Runs `work` with the account store of one request's identity-store connection. */
export type AccountAccess = <Result>(
  work: (store: AccountStore) => Promise<Result>
) => Promise<Result>;

/** A `timestamptz` inside a `jsonb` value, which carries its UTC offset, as ISO 8601 in UTC. */
const JsonTimeSchema = z.iso
  .datetime({ offset: true })
  .transform(value => new Date(value).toISOString());
const NullableJsonTimeSchema = JsonTimeSchema.nullable();

const PatJsonSchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    audience: z.string(),
    scope: z.string(),
    org: z.uuid().nullable(),
    last_four: z.string(),
    created_at: JsonTimeSchema,
    expires_at: JsonTimeSchema,
    last_used_at: NullableJsonTimeSchema,
  })
  .pipe(PatSummarySchema);

const BotKeyJsonSchema = z
  .looseObject({
    created_at: JsonTimeSchema,
    expires_at: JsonTimeSchema,
    last_used_at: NullableJsonTimeSchema,
    flagged_at: JsonTimeSchema.optional(),
    stops_at: JsonTimeSchema.optional(),
    kept_at: JsonTimeSchema.optional(),
  })
  .pipe(BotKeySummarySchema);

const failure = <const Outcomes extends readonly [string, ...string[]]>(outcomes: Outcomes) =>
  z.object({ outcome: z.enum(outcomes) });

const CreatePatRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('created'),
    new_pat_id: z.uuid(),
    pat_created_at: z.date(),
    pat_expires_at: z.date(),
  }),
  failure(['invalid_session', 'gate_required', 'org_denied', 'limit_reached', 'rate_limited']),
]);

const ListPatsRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('listed'), pats: z.array(PatJsonSchema) }),
  failure(['invalid_session']),
]);

const RevokePatRowSchema = z.object({
  outcome: z.enum(['revoked', 'already_revoked', 'not_found', 'invalid_session']),
  feed_entries: StatementFeedEntriesSchema,
});

const RevokeBotKeyRowSchema = z.object({
  outcome: z.enum(['revoked', 'already_revoked', 'not_found', 'invalid_session', 'not_org_admin']),
  feed_entries: StatementFeedEntriesSchema,
});

/**
 * The select list of a revoke function whose credential has revocation kind `kind` and id in
 * parameter `$idParameter`: its outcome, and the feed entries to publish, read in the same
 * statement. For `revoked` they are the entries the statement wrote
 * (`uts.feed_entries_of_statement()`, migration 0006); for `already_revoked` the credential's
 * entry while it still lives (`uts.live_feed_entries`, migration 0019), so a retry after a revoke
 * that no feed object confirmed publishes it again.
 */
const withFeedEntries = (kind: 'pat' | 'bot_key', idParameter: number) =>
  `result.outcome, CASE result.outcome
    WHEN 'revoked' THEN uts.feed_entries_of_statement()
    WHEN 'already_revoked' THEN uts.live_feed_entries('${kind}', $${idParameter}::text)
    ELSE '[]'::jsonb END AS feed_entries`;

const CreateBotKeyRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('created'),
    new_key_id: z.uuid(),
    key_created_at: z.date(),
    key_expires_at: z.date(),
  }),
  failure(['invalid_session', 'gate_required', 'not_org_admin', 'limit_reached', 'rate_limited']),
]);

const ListBotKeysRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('listed'), keys: z.array(BotKeyJsonSchema) }),
  failure(['invalid_session', 'not_org_admin']),
]);

const KeepRowSchema = z.object({
  outcome: z.enum([
    'kept',
    'not_flagged',
    'lapsed',
    'not_found',
    'invalid_session',
    'not_org_admin',
    'gate_required',
  ]),
});

/** Every account statement over one identity-store connection. */
export function identityStoreAccount(store: IdentityStore): AccountStore {
  async function one<Row extends z.ZodType>(
    text: string,
    values: readonly unknown[],
    row: Row
  ): Promise<z.output<Row>> {
    const result = await store.maybeOne({ text, values }, row);
    if (result === null) throw new Error('an account function returned no row');
    return result;
  }

  return {
    async createPat(input) {
      const row = await one(
        'SELECT * FROM uts.create_pat($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          input.environment,
          input.accountId,
          input.grantId,
          input.name,
          input.tokenHash,
          input.lastFour,
          input.scope,
          input.orgId,
          input.lifetimeDays,
        ],
        CreatePatRowSchema
      );
      if (row.outcome !== 'created') return { outcome: row.outcome };
      return {
        outcome: 'created',
        id: row.new_pat_id,
        createdAt: row.pat_created_at,
        expiresAt: row.pat_expires_at,
      };
    },

    async listPats(session) {
      const row = await one(
        'SELECT * FROM uts.list_pats($1, $2)',
        [session.accountId, session.grantId],
        ListPatsRowSchema
      );
      return row.outcome === 'listed' ? { outcome: 'listed', pats: row.pats } : row;
    },

    async revokePat(input) {
      const row = await one(
        `SELECT ${withFeedEntries('pat', 4)} FROM uts.revoke_pat($1, $2, $3, $4) AS result`,
        [input.environment, input.accountId, input.grantId, input.patId],
        RevokePatRowSchema
      );
      return { outcome: row.outcome, feedEntries: row.feed_entries };
    },

    async createBotKey(input) {
      const row = await one(
        'SELECT * FROM uts.create_bot_key($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          input.environment,
          input.accountId,
          input.grantId,
          input.orgId,
          input.name,
          input.tokenHash,
          input.lastFour,
          input.scope,
          input.lifetimeDays,
        ],
        CreateBotKeyRowSchema
      );
      if (row.outcome !== 'created') return { outcome: row.outcome };
      return {
        outcome: 'created',
        id: row.new_key_id,
        createdAt: row.key_created_at,
        expiresAt: row.key_expires_at,
      };
    },

    async listBotKeys(session) {
      const row = await one(
        'SELECT * FROM uts.list_bot_keys($1, $2, $3)',
        [session.accountId, session.grantId, session.orgId],
        ListBotKeysRowSchema
      );
      return row.outcome === 'listed' ? { outcome: 'listed', botKeys: row.keys } : row;
    },

    async revokeBotKey(input) {
      const row = await one(
        `SELECT ${withFeedEntries('bot_key', 5)} FROM uts.revoke_bot_key($1, $2, $3, $4, $5) AS result`,
        [input.environment, input.accountId, input.grantId, input.orgId, input.keyId],
        RevokeBotKeyRowSchema
      );
      return { outcome: row.outcome, feedEntries: row.feed_entries };
    },

    async keepBotKey(input) {
      const row = await one(
        'SELECT * FROM uts.keep_bot_key($1, $2, $3, $4, $5)',
        [input.environment, input.accountId, input.grantId, input.orgId, input.keyId],
        KeepRowSchema
      );
      return row.outcome;
    },
  };
}
