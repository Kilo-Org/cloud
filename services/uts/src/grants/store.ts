import type { UtsEnvironment, UtsOrgRole } from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { IdentityStore } from '../db/client';
import { CLIENT_KINDS, ORG_ROLES } from '../db/enums';
import { type FeedEntry, StatementFeedEntriesSchema } from '../revocation/entries';

/**
 * The OAuth grant statements (migration `0004_oauth_grants.sql`). Each call is one SQL statement:
 * a SECURITY DEFINER function that writes the credential rows and their audit row together, or a
 * read. Results arrive as one row whose `outcome` column picks the shape; the other columns are
 * set only for `issued`.
 */

/** Where a device sign-in came from, for the user's device list (design 8.2, network fields). */
export type DeviceContext = {
  label: string;
  platform: string;
  clientIp: string | null;
  asn: number | null;
  country: string | null;
  city: string | null;
};

export type IssueCodeInput = {
  environment: UtsEnvironment;
  codeHash: Uint8Array;
  client:
    | { kind: 'first_party'; clientId: string; dpopJkt: Uint8Array }
    /** The web BFF: no DPoP key; `browserSessionId` names the session it will hold a handle to. */
    | { kind: 'confidential_web'; clientId: string }
    | { kind: 'third_party'; clientId: string; consentId: string };
  accountId: string;
  browserSessionId: string | null;
  redirectUri: string;
  audiences: readonly string[];
  /** A canonical scope set: unique and in ascending byte order. */
  scopes: readonly string[];
  orgId: string | null;
  codeChallenge: string;
  authTime: Date;
  amr: readonly string[];
};

/**
 * `orgRole`: the caller's role in `orgId` (`uts.org_role`), null without an organization.
 * `invalid_scope`: a requested scope is limited to membership roles the caller does not hold
 * (`uts.scope_org_roles`); nothing was stored.
 */
export type IssueCodeResult =
  | { outcome: 'issued'; orgRole: UtsOrgRole | null }
  | { outcome: 'access_denied' | 'consent_required' | 'invalid_scope' };

/** `scopes` and `resources` null mean "not named in the request". */
type TokenSelection = { scopes: readonly string[] | null; resources: readonly string[] | null };

/**
 * A verified DPoP proof: the RFC 7638 thumbprint of its key, as the raw 32 bytes a grant stores,
 * and its `jti`, which the statement records under that key so the proof is accepted once.
 */
export type ProofBinding = { jkt: Uint8Array; jti: string };

export type ExchangeCodeInput = TokenSelection & {
  environment: UtsEnvironment;
  codeHash: Uint8Array;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  binding:
    | {
        kind: 'first_party';
        proof: ProofBinding;
        clientClass: 'desktop' | 'mobile';
        device: DeviceContext;
      }
    | { kind: 'third_party' };
  /** Derived from the code (`grantIdOfCode`), so every attempt with one code names one grant. */
  grantId: string;
  refreshTokenHash: Uint8Array;
};

export type FirstPartyRefreshInput = TokenSelection & {
  environment: UtsEnvironment;
  tokenHash: Uint8Array;
  grantId: string;
  clientId: string;
  proof: ProofBinding;
};

export type ThirdPartyRefreshInput = TokenSelection & {
  environment: UtsEnvironment;
  tokenHash: Uint8Array;
  clientId: string;
  newTokenHash: Uint8Array;
};

/** What a mint statement returns for the claims of its tokens. */
export type Minted = {
  subjectId: string;
  orgId: string | null;
  /**
   * The subject's membership role in `orgId`, read by the mint statement (migration 0005); null
   * without an organization and for a third-party refresh, which reads no role.
   */
  orgRole: UtsOrgRole | null;
  authTime: Date;
  amr: string[];
  /** One `jti` per token, in the order of `scopes`. */
  tokenIds: string[];
  scopes: string[];
};

type SelectionFailure = 'invalid_grant' | 'invalid_scope' | 'invalid_target';

/**
 * `dpop_replay`: the proof's `jti` was recorded under its key before. A failed exchange carries
 * the feed entries its statement wrote: a second use of a code revokes the grant the code created.
 */
export type ExchangeResult =
  | ({ outcome: 'issued'; refreshExpiresAt: Date } & Minted)
  | { outcome: SelectionFailure | 'dpop_replay'; feedEntries: FeedEntry[] };
export type FirstPartyRefreshResult =
  | ({ outcome: 'issued' } & Minted)
  | { outcome: SelectionFailure | 'dpop_mismatch' | 'dpop_replay' };
/** A failed third-party refresh carries the feed entries of a family that reuse revoked. */
export type ThirdPartyRefreshResult =
  | ({ outcome: 'issued'; familyId: string; refreshExpiresAt: Date } & Minted)
  | { outcome: SelectionFailure | 'reuse_detected'; feedEntries: FeedEntry[] };

export type RevokeInput = { environment: UtsEnvironment; tokenHash: Uint8Array; clientId: string };
/** The outcome and the feed entries the statement wrote, which the caller publishes. */
export type RevokeResult = {
  outcome: 'revoked' | 'already_revoked' | 'unknown' | 'client_mismatch';
  feedEntries: FeedEntry[];
};

export type IntrospectInput = {
  tokenHash: Uint8Array;
  clientId: string;
  /** The verified DPoP proof of a first-party request; null for a third-party client. */
  proof: ProofBinding | null;
};
export type ActiveRefreshToken = {
  kind: (typeof CLIENT_KINDS)[number];
  grantId: string;
  subjectId: string;
  scopes: string[];
  issuedAt: Date;
  expiresAt: Date;
};
export type IntrospectResult =
  | ({ outcome: 'active' } & ActiveRefreshToken)
  | { outcome: 'inactive' | 'dpop_replay' };

/**
 * The store step of the RFC 8693 broker exchange (migration 0012), after the Worker verified the
 * caller and the subject token. `grantId` is the subject token's `sid`: a consent family for a
 * third-party client, a refresh grant for a first-party one.
 */
export type DelegatedExchangeInput = {
  environment: UtsEnvironment;
  clientKind: (typeof CLIENT_KINDS)[number];
  accountId: string;
  clientId: string;
  grantId: string;
  orgId: string | null;
  subjectScope: string;
  subjectIssuedAt: Date;
  subjectTokenId: string;
  subjectKid: string;
  scope: string;
  /** The calling workload: `act.sub` and `req` of the new token. */
  actor: string;
  lifetimeSeconds: number;
};

/** `issued` names the one token the caller signs; nothing else was written but the audit row. */
export type DelegatedExchangeResult =
  | { outcome: 'issued'; tokenId: string }
  | { outcome: 'invalid_grant' | 'invalid_scope' };

export type GrantStore = {
  issueCode(input: IssueCodeInput): Promise<IssueCodeResult>;
  exchangeCode(input: ExchangeCodeInput): Promise<ExchangeResult>;
  refreshFirstParty(input: FirstPartyRefreshInput): Promise<FirstPartyRefreshResult>;
  refreshThirdParty(input: ThirdPartyRefreshInput): Promise<ThirdPartyRefreshResult>;
  revoke(input: RevokeInput): Promise<RevokeResult>;
  introspect(input: IntrospectInput): Promise<IntrospectResult>;
  exchangeDelegated(input: DelegatedExchangeInput): Promise<DelegatedExchangeResult>;
};

/** Runs `work` with the grant store of one request's identity-store connection. */
export type GrantsAccess = <Result>(
  work: (grants: GrantStore) => Promise<Result>
) => Promise<Result>;

const MintedColumns = {
  subject_id: z.string(),
  bound_org_id: z.uuid().nullable(),
  signed_in_at: z.date(),
  sign_in_methods: z.array(z.string()),
  token_ids: z.array(z.uuid()).min(1),
  token_scopes: z.array(z.string()).min(1),
};

const OrgRoleColumn = { org_role: z.enum(ORG_ROLES).nullable() };

function minted(
  row: z.output<z.ZodObject<typeof MintedColumns>>,
  orgRole: UtsOrgRole | null
): Minted {
  return {
    subjectId: row.subject_id,
    orgId: row.bound_org_id,
    orgRole,
    authTime: row.signed_in_at,
    amr: row.sign_in_methods,
    tokenIds: row.token_ids,
    scopes: row.token_scopes,
  };
}

const failure = <const Outcomes extends readonly [string, ...string[]]>(outcomes: Outcomes) =>
  z.object({ outcome: z.enum(outcomes) });

/** A failure row of a statement that can revoke: it carries the entries the statement wrote. */
const revokingFailure = <const Outcomes extends readonly [string, ...string[]]>(
  outcomes: Outcomes
) => z.object({ outcome: z.enum(outcomes), feed_entries: StatementFeedEntriesSchema });

/**
 * The select list of a grant function that can revoke: its row, and for any outcome but `issued`
 * the feed entries the statement wrote (`uts.feed_entries_of_statement()`, migration 0006). The
 * CASE leaves the issued path, the hot one, without the extra probe.
 */
const WITH_FEED_ENTRIES = `result.*, CASE WHEN result.outcome = 'issued' THEN '[]'::jsonb
  ELSE uts.feed_entries_of_statement() END AS feed_entries`;

const IssueCodeRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('issued'), ...OrgRoleColumn }),
  failure(['access_denied', 'consent_required', 'invalid_scope']),
]);

const ExchangeRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('issued'),
    ...MintedColumns,
    ...OrgRoleColumn,
    refresh_expires_at: z.date(),
  }),
  revokingFailure(['invalid_grant', 'invalid_scope', 'invalid_target', 'dpop_replay']),
]);

const FirstPartyRefreshRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('issued'), ...MintedColumns, ...OrgRoleColumn }),
  failure(['invalid_grant', 'invalid_scope', 'invalid_target', 'dpop_mismatch', 'dpop_replay']),
]);

const ThirdPartyRefreshRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('issued'),
    ...MintedColumns,
    family_id: z.uuid(),
    refresh_expires_at: z.date(),
  }),
  revokingFailure(['invalid_grant', 'invalid_scope', 'invalid_target', 'reuse_detected']),
]);

const RevokeRowSchema = z.object({
  outcome: z.enum(['revoked', 'already_revoked', 'unknown', 'client_mismatch']),
  feed_entries: StatementFeedEntriesSchema,
});

const IntrospectRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('active'),
    grant_kind: z.enum(CLIENT_KINDS),
    grant_id: z.uuid(),
    subject_id: z.string(),
    granted_scopes: z.array(z.string()).min(1),
    issued_at: z.date(),
    expires_at: z.date(),
  }),
  failure(['inactive', 'dpop_replay']),
]);

const DelegatedExchangeRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('issued'), token_id: z.uuid() }),
  failure(['invalid_grant', 'invalid_scope']),
]);

/** Every grant statement over one identity-store connection. */
export function identityStoreGrants(store: IdentityStore): GrantStore {
  async function one<Row extends z.ZodType>(
    text: string,
    values: readonly unknown[],
    row: Row
  ): Promise<z.output<Row>> {
    const result = await store.maybeOne({ text, values }, row);
    if (result === null) throw new Error('a grant function returned no row');
    return result;
  }

  return {
    async issueCode(input) {
      const row = await one(
        'SELECT * FROM uts.issue_authorization_code($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
        [
          input.environment,
          input.codeHash,
          input.client.clientId,
          // `uts.client_kind` has no web kind: the web BFF is a first-party client.
          input.client.kind === 'third_party' ? 'third_party' : 'first_party',
          input.accountId,
          input.browserSessionId,
          input.redirectUri,
          input.audiences,
          input.scopes,
          input.orgId,
          input.codeChallenge,
          input.client.kind === 'first_party' ? input.client.dpopJkt : null,
          input.authTime,
          input.amr,
          input.client.kind === 'third_party' ? input.client.consentId : null,
        ],
        IssueCodeRowSchema
      );
      return row.outcome === 'issued'
        ? { outcome: 'issued', orgRole: row.org_role }
        : { outcome: row.outcome };
    },

    async exchangeCode(input) {
      const firstParty = input.binding.kind === 'first_party' ? input.binding : null;
      const device = firstParty?.device ?? null;
      const row = await one(
        `SELECT ${WITH_FEED_ENTRIES} FROM uts.exchange_authorization_code($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) AS result`,
        [
          input.environment,
          input.codeHash,
          input.clientId,
          input.redirectUri,
          input.codeChallenge,
          firstParty?.proof.jkt ?? null,
          firstParty?.proof.jti ?? null,
          input.grantId,
          input.refreshTokenHash,
          firstParty?.clientClass ?? null,
          device?.label ?? null,
          device?.platform ?? null,
          device?.clientIp ?? null,
          device?.asn ?? null,
          device?.country ?? null,
          device?.city ?? null,
          input.scopes,
          input.resources,
        ],
        ExchangeRowSchema
      );
      if (row.outcome !== 'issued') return { outcome: row.outcome, feedEntries: row.feed_entries };
      return {
        outcome: 'issued',
        refreshExpiresAt: row.refresh_expires_at,
        ...minted(row, row.org_role),
      };
    },

    async refreshFirstParty(input) {
      const row = await one(
        'SELECT * FROM uts.refresh_first_party($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          input.environment,
          input.tokenHash,
          input.grantId,
          input.clientId,
          input.proof.jkt,
          input.proof.jti,
          input.scopes,
          input.resources,
        ],
        FirstPartyRefreshRowSchema
      );
      if (row.outcome !== 'issued') return { outcome: row.outcome };
      return { outcome: 'issued', ...minted(row, row.org_role) };
    },

    async refreshThirdParty(input) {
      const row = await one(
        `SELECT ${WITH_FEED_ENTRIES} FROM uts.refresh_third_party($1, $2, $3, $4, $5, $6) AS result`,
        [
          input.environment,
          input.tokenHash,
          input.clientId,
          input.newTokenHash,
          input.scopes,
          input.resources,
        ],
        ThirdPartyRefreshRowSchema
      );
      if (row.outcome !== 'issued') return { outcome: row.outcome, feedEntries: row.feed_entries };
      return {
        outcome: 'issued',
        familyId: row.family_id,
        refreshExpiresAt: row.refresh_expires_at,
        ...minted(row, null),
      };
    },

    async revoke(input) {
      const row = await one(
        `SELECT ${WITH_FEED_ENTRIES} FROM uts.revoke_refresh_token($1, $2, $3) AS result`,
        [input.environment, input.tokenHash, input.clientId],
        RevokeRowSchema
      );
      return { outcome: row.outcome, feedEntries: row.feed_entries };
    },

    async introspect(input) {
      const row = await one(
        'SELECT * FROM uts.introspect_refresh_token($1, $2, $3, $4)',
        [input.tokenHash, input.clientId, input.proof?.jkt ?? null, input.proof?.jti ?? null],
        IntrospectRowSchema
      );
      if (row.outcome !== 'active') return { outcome: row.outcome };
      return {
        outcome: 'active',
        kind: row.grant_kind,
        grantId: row.grant_id,
        subjectId: row.subject_id,
        scopes: row.granted_scopes,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
      };
    },

    async exchangeDelegated(input) {
      const row = await one(
        `SELECT * FROM uts.exchange_delegated_token(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          input.environment,
          input.clientKind,
          input.accountId,
          input.clientId,
          input.grantId,
          input.orgId,
          input.subjectScope,
          input.subjectIssuedAt,
          input.subjectTokenId,
          input.subjectKid,
          input.scope,
          input.actor,
          input.lifetimeSeconds,
        ],
        DelegatedExchangeRowSchema
      );
      return row.outcome === 'issued'
        ? { outcome: 'issued', tokenId: row.token_id }
        : { outcome: row.outcome };
    },
  };
}
