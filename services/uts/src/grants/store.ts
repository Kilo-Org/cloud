import type { UtsEnvironment } from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { IdentityStore } from '../db/client';
import { CLIENT_KINDS } from '../db/enums';

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
export type IssueCodeResult = 'issued' | 'access_denied' | 'consent_required';

/** `scopes` and `resources` null mean "not named in the request". */
type TokenSelection = { scopes: readonly string[] | null; resources: readonly string[] | null };

/**
 * A verified DPoP proof: the RFC 7638 thumbprint of its key, as the raw 32 bytes a grant stores,
 * and its `jti`, which the statement records under the grant so the proof is accepted once.
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
  authTime: Date;
  amr: string[];
  /** One `jti` per token, in the order of `scopes`. */
  tokenIds: string[];
  scopes: string[];
};

type SelectionFailure = 'invalid_grant' | 'invalid_scope' | 'invalid_target';

/** `dpop_replay`: the proof's `jti` was recorded under the grant before. */
export type ExchangeResult =
  | ({ outcome: 'issued'; refreshExpiresAt: Date } & Minted)
  | { outcome: SelectionFailure | 'dpop_replay' };
export type FirstPartyRefreshResult =
  | ({ outcome: 'issued' } & Minted)
  | { outcome: SelectionFailure | 'dpop_mismatch' | 'dpop_replay' };
export type ThirdPartyRefreshResult =
  | ({ outcome: 'issued'; familyId: string; refreshExpiresAt: Date } & Minted)
  | { outcome: SelectionFailure | 'reuse_detected' };

export type RevokeInput = { environment: UtsEnvironment; tokenHash: Uint8Array; clientId: string };
export type RevokeResult = 'revoked' | 'already_revoked' | 'unknown' | 'client_mismatch';

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

export type ThirdPartyClientRecord = { clientId: string; name: string; redirectUris: string[] };

export type GrantStore = {
  findThirdPartyClient(clientId: string): Promise<ThirdPartyClientRecord | null>;
  issueCode(input: IssueCodeInput): Promise<IssueCodeResult>;
  exchangeCode(input: ExchangeCodeInput): Promise<ExchangeResult>;
  refreshFirstParty(input: FirstPartyRefreshInput): Promise<FirstPartyRefreshResult>;
  refreshThirdParty(input: ThirdPartyRefreshInput): Promise<ThirdPartyRefreshResult>;
  revoke(input: RevokeInput): Promise<RevokeResult>;
  introspect(input: IntrospectInput): Promise<IntrospectResult>;
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

function minted(row: z.output<z.ZodObject<typeof MintedColumns>>): Minted {
  return {
    subjectId: row.subject_id,
    orgId: row.bound_org_id,
    authTime: row.signed_in_at,
    amr: row.sign_in_methods,
    tokenIds: row.token_ids,
    scopes: row.token_scopes,
  };
}

const failure = <const Outcomes extends readonly [string, ...string[]]>(outcomes: Outcomes) =>
  z.object({ outcome: z.enum(outcomes) });

const IssueCodeRowSchema = z.object({
  outcome: z.enum(['issued', 'access_denied', 'consent_required']),
});

const ExchangeRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('issued'), ...MintedColumns, refresh_expires_at: z.date() }),
  failure(['invalid_grant', 'invalid_scope', 'invalid_target', 'dpop_replay']),
]);

const FirstPartyRefreshRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('issued'), ...MintedColumns }),
  failure(['invalid_grant', 'invalid_scope', 'invalid_target', 'dpop_mismatch', 'dpop_replay']),
]);

const ThirdPartyRefreshRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('issued'),
    ...MintedColumns,
    family_id: z.uuid(),
    refresh_expires_at: z.date(),
  }),
  failure(['invalid_grant', 'invalid_scope', 'invalid_target', 'reuse_detected']),
]);

const RevokeRowSchema = z.object({
  outcome: z.enum(['revoked', 'already_revoked', 'unknown', 'client_mismatch']),
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

const ThirdPartyClientRowSchema = z.object({
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
});

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
    async findThirdPartyClient(clientId) {
      const row = await store.maybeOne(
        {
          text: `SELECT client_name, redirect_uris FROM uts.third_party_clients
                 WHERE client_id = $1 AND status = 'active'`,
          values: [clientId],
        },
        ThirdPartyClientRowSchema
      );
      return row === null
        ? null
        : { clientId, name: row.client_name, redirectUris: row.redirect_uris };
    },

    async issueCode(input) {
      const row = await one(
        'SELECT * FROM uts.issue_authorization_code($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
        [
          input.environment,
          input.codeHash,
          input.client.clientId,
          input.client.kind,
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
      return row.outcome;
    },

    async exchangeCode(input) {
      const firstParty = input.binding.kind === 'first_party' ? input.binding : null;
      const device = firstParty?.device ?? null;
      const row = await one(
        'SELECT * FROM uts.exchange_authorization_code($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)',
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
      if (row.outcome !== 'issued') return { outcome: row.outcome };
      return { outcome: 'issued', refreshExpiresAt: row.refresh_expires_at, ...minted(row) };
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
      return { outcome: 'issued', ...minted(row) };
    },

    async refreshThirdParty(input) {
      const row = await one(
        'SELECT * FROM uts.refresh_third_party($1, $2, $3, $4, $5, $6)',
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
      if (row.outcome !== 'issued') return { outcome: row.outcome };
      return {
        outcome: 'issued',
        familyId: row.family_id,
        refreshExpiresAt: row.refresh_expires_at,
        ...minted(row),
      };
    },

    async revoke(input) {
      const row = await one(
        'SELECT * FROM uts.revoke_refresh_token($1, $2, $3)',
        [input.environment, input.tokenHash, input.clientId],
        RevokeRowSchema
      );
      return row.outcome;
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
  };
}
