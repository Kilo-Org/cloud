import type { UtsEnvironment } from '@kilocode/uts-contracts';
import { z } from 'zod';
import { type IdentityStore, type WaitUntil, withIdentityStore } from '../db/client';
import { ORG_ROLES } from '../db/enums';
import type { Minted } from '../grants/store';
import { type FeedEntry, StatementFeedEntriesSchema } from '../revocation/entries';
import type { JtiUse } from './client-auth';

/**
 * The browser-session statements of the web BFF `kilo-web` (migration 0013). Each call is one SQL
 * statement: a SECURITY DEFINER function that records the client assertion's `jti` and does the
 * work with its audit row, or answers why not. Results arrive as one row whose `outcome` column
 * picks the shape.
 */

/** A browser session as the BFF sees it; `authTime` and `amr` are the current handle's sign-in. */
export type WebSession = {
  sessionId: string;
  subject: string;
  authTime: Date;
  amr: string[];
  sso: { connection: string; organization: string | null } | null;
  issuedAt: Date;
  idleExpiresAt: Date;
  expiresAt: Date;
};

type SessionTokens = Minted & { session: WebSession };

export type WebCodeInput = {
  environment: UtsEnvironment;
  codeHash: Uint8Array;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  assertion: JtiUse;
  handleHash: Uint8Array;
  scopes: readonly string[] | null;
  resources: readonly string[] | null;
};

export type WebCodeResult =
  | ({ outcome: 'issued' } & SessionTokens)
  | { outcome: 'invalid_grant' | 'invalid_scope' | 'invalid_target' | 'assertion_replay' };

export type HandleInput = {
  environment: UtsEnvironment;
  handleHash: Uint8Array;
  assertion: JtiUse;
};

export type ReadResult =
  | { outcome: 'active'; session: WebSession }
  | { outcome: 'invalid_session' | 'assertion_replay' };

export type MintInput = HandleInput & { scope: string; stepUp: boolean };
export type MintResult =
  | ({ outcome: 'issued'; sessionId: string } & Minted)
  | { outcome: 'invalid_session' | 'step_up_required' | 'assertion_replay' };

/** A revoking call's outcome and the feed entries to publish (also on a repeat). */
export type EndResult =
  | { outcome: 'ended'; sessionId: string; feedEntries: FeedEntry[] }
  | { outcome: 'already_ended'; feedEntries: FeedEntry[] }
  /** `invalid_session`: the handle names no stored session (never issued, or replaced). */
  | { outcome: 'invalid_session' | 'assertion_replay' };
export type EndAllResult =
  | { outcome: 'ended'; ended: number; feedEntries: FeedEntry[] }
  | { outcome: 'assertion_replay' };
export type DeviceRevokeResult =
  | { outcome: 'ended'; feedEntries: FeedEntry[] }
  | { outcome: 'invalid_session' | 'assertion_replay' };

export type BridgeInput = {
  environment: UtsEnvironment;
  accountId: string;
  authTime: Date;
  /** Null unless the authority check confirmed the WorkOS ids. */
  sso: { connection: string; organization: string | null } | null;
  assertion: JtiUse;
  subjectToken: JtiUse;
  handleHash: Uint8Array;
  /** A canonical scope set: unique and in ascending byte order. */
  scopes: readonly string[];
};
export type BridgeResult =
  | ({ outcome: 'issued' } & SessionTokens)
  | { outcome: 'invalid_grant' | 'invalid_scope' | 'assertion_replay' };

export type WebSessionStore = {
  exchangeCode(input: WebCodeInput): Promise<WebCodeResult>;
  read(input: Omit<HandleInput, 'environment'>): Promise<ReadResult>;
  mint(input: MintInput): Promise<MintResult>;
  end(input: HandleInput): Promise<EndResult>;
  endAll(input: HandleInput): Promise<EndAllResult>;
  revokeDevice(input: HandleInput & { sid: string }): Promise<DeviceRevokeResult>;
  bridge(input: BridgeInput): Promise<BridgeResult>;
};

/** Runs `work` with the statements of one request's identity-store connection. */
export type WebSessionAccess = <Result>(
  work: (store: WebSessionStore) => Promise<Result>
) => Promise<Result>;

export function webSessionAccess(connectionString: string, context: WaitUntil): WebSessionAccess {
  return work =>
    withIdentityStore(connectionString, context, store => work(identityStoreWebSessions(store)));
}

const SessionColumns = {
  subject_id: z.string().min(1).max(255),
  web_session_id: z.uuid(),
  signed_in_at: z.date(),
  sign_in_methods: z.array(z.string()).min(1),
  sso_connection: z.string().nullable(),
  sso_organization: z.string().nullable(),
  handle_issued: z.date(),
  idle_end: z.date(),
  session_end: z.date(),
};

const TokenColumns = {
  token_ids: z.array(z.uuid()).min(1),
  token_scopes: z.array(z.string()).min(1),
};

function sessionOf(row: z.output<z.ZodObject<typeof SessionColumns>>): WebSession {
  return {
    sessionId: row.web_session_id,
    subject: row.subject_id,
    authTime: row.signed_in_at,
    amr: row.sign_in_methods,
    sso:
      row.sso_connection === null
        ? null
        : { connection: row.sso_connection, organization: row.sso_organization },
    issuedAt: row.handle_issued,
    idleExpiresAt: row.idle_end,
    expiresAt: row.session_end,
  };
}

const failure = <const Outcomes extends readonly [string, ...string[]]>(outcomes: Outcomes) =>
  z.object({ outcome: z.enum(outcomes) });

const WebCodeRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('issued'),
    ...SessionColumns,
    ...TokenColumns,
    bound_org_id: z.uuid().nullable(),
    org_role: z.enum(ORG_ROLES).nullable(),
  }),
  failure(['invalid_grant', 'invalid_scope', 'invalid_target', 'assertion_replay']),
]);

const ReadRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('active'), ...SessionColumns }),
  failure(['invalid_session', 'assertion_replay']),
]);

const MintRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('issued'),
    subject_id: z.string().min(1).max(255),
    web_session_id: z.uuid(),
    signed_in_at: z.date(),
    sign_in_methods: z.array(z.string()).min(1),
    ...TokenColumns,
  }),
  failure(['invalid_session', 'step_up_required', 'assertion_replay']),
]);

const EndRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ended'),
    web_session_id: z.uuid(),
    feed_entries: StatementFeedEntriesSchema,
  }),
  z.object({ outcome: z.literal('already_ended'), feed_entries: StatementFeedEntriesSchema }),
  failure(['invalid_session', 'assertion_replay']),
]);

const EndAllRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ended'),
    ended: z.number().int().nonnegative(),
    feed_entries: StatementFeedEntriesSchema,
  }),
  failure(['assertion_replay']),
]);

const DeviceRevokeRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ended'), feed_entries: StatementFeedEntriesSchema }),
  failure(['invalid_session', 'assertion_replay']),
]);

const BridgeRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('issued'), ...SessionColumns, ...TokenColumns }),
  failure(['invalid_grant', 'invalid_scope', 'assertion_replay']),
]);

/** The minted tokens of a session-bound statement: no organization, no role. */
function sessionMinted(
  session: WebSession,
  row: z.output<z.ZodObject<typeof TokenColumns>>
): Minted {
  return {
    subjectId: session.subject,
    orgId: null,
    orgRole: null,
    authTime: session.authTime,
    amr: session.amr,
    tokenIds: row.token_ids,
    scopes: row.token_scopes,
  };
}

/** Every browser-session statement over one identity-store connection. */
export function identityStoreWebSessions(store: IdentityStore): WebSessionStore {
  async function one<Row extends z.ZodType>(
    text: string,
    values: readonly unknown[],
    row: Row
  ): Promise<z.output<Row>> {
    const result = await store.maybeOne({ text, values }, row);
    if (result === null) throw new Error('a browser-session function returned no row');
    return result;
  }
  const handleValues = (input: HandleInput) => [
    input.environment,
    input.handleHash,
    input.assertion.jkt,
    input.assertion.jti,
    input.assertion.expiresAt,
  ];

  return {
    async exchangeCode(input) {
      const row = await one(
        'SELECT * FROM uts.exchange_web_code($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [
          input.environment,
          input.codeHash,
          input.clientId,
          input.redirectUri,
          input.codeChallenge,
          input.assertion.jkt,
          input.assertion.jti,
          input.assertion.expiresAt,
          input.handleHash,
          input.scopes,
          input.resources,
        ],
        WebCodeRowSchema
      );
      if (row.outcome !== 'issued') return { outcome: row.outcome };
      const session = sessionOf(row);
      return {
        outcome: 'issued',
        session,
        ...sessionMinted(session, row),
        orgId: row.bound_org_id,
        orgRole: row.org_role,
      };
    },

    async read(input) {
      const row = await one(
        'SELECT * FROM uts.read_web_session($1, $2, $3, $4)',
        [input.handleHash, input.assertion.jkt, input.assertion.jti, input.assertion.expiresAt],
        ReadRowSchema
      );
      return row.outcome === 'active'
        ? { outcome: 'active', session: sessionOf(row) }
        : { outcome: row.outcome };
    },

    async mint(input) {
      const row = await one(
        'SELECT * FROM uts.mint_web_session_token($1, $2, $3, $4, $5, $6, $7)',
        [...handleValues(input), input.scope, input.stepUp],
        MintRowSchema
      );
      if (row.outcome !== 'issued') return { outcome: row.outcome };
      return {
        outcome: 'issued',
        sessionId: row.web_session_id,
        subjectId: row.subject_id,
        orgId: null,
        orgRole: null,
        authTime: row.signed_in_at,
        amr: row.sign_in_methods,
        tokenIds: row.token_ids,
        scopes: row.token_scopes,
      };
    },

    async end(input) {
      const row = await one(
        'SELECT * FROM uts.end_web_session($1, $2, $3, $4, $5)',
        handleValues(input),
        EndRowSchema
      );
      if (row.outcome === 'ended') {
        return { outcome: 'ended', sessionId: row.web_session_id, feedEntries: row.feed_entries };
      }
      if (row.outcome === 'already_ended') {
        return { outcome: 'already_ended', feedEntries: row.feed_entries };
      }
      return { outcome: row.outcome };
    },

    async endAll(input) {
      const row = await one(
        'SELECT * FROM uts.end_all_web_sessions($1, $2, $3, $4, $5)',
        handleValues(input),
        EndAllRowSchema
      );
      return row.outcome === 'ended'
        ? { outcome: 'ended', ended: row.ended, feedEntries: row.feed_entries }
        : { outcome: row.outcome };
    },

    async revokeDevice(input) {
      const row = await one(
        'SELECT * FROM uts.revoke_web_device($1, $2, $3, $4, $5, $6)',
        [...handleValues(input), input.sid],
        DeviceRevokeRowSchema
      );
      return row.outcome === 'ended'
        ? { outcome: 'ended', feedEntries: row.feed_entries }
        : { outcome: row.outcome };
    },

    async bridge(input) {
      const row = await one(
        'SELECT * FROM uts.bridge_legacy_session($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
        [
          input.environment,
          input.accountId,
          input.authTime,
          input.sso?.connection ?? null,
          input.sso?.organization ?? null,
          input.assertion.jkt,
          input.assertion.jti,
          input.assertion.expiresAt,
          input.subjectToken.jkt,
          input.subjectToken.jti,
          input.subjectToken.expiresAt,
          input.handleHash,
          input.scopes,
        ],
        BridgeRowSchema
      );
      if (row.outcome !== 'issued') return { outcome: row.outcome };
      const session = sessionOf(row);
      return { outcome: 'issued', session, ...sessionMinted(session, row) };
    },
  };
}
