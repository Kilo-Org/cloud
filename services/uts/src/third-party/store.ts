import type { UtsEnvironment } from '@kilocode/uts-contracts';
import { z } from 'zod';
import { type IdentityStore, type WaitUntil, withIdentityStore } from '../db/client';
import { type FeedEntry, StatementFeedEntriesSchema } from '../revocation/entries';
import type { ClientMetadata } from './metadata';

/**
 * The third-party client and consent statements (migrations 0001, 0012 and 0021). Each call is one
 * SQL statement: a plain read of a cached client or consent, or a SECURITY DEFINER function that
 * writes the client document, or the consent rows with their audit row.
 */

/** A cached third-party client that may authorize. */
export type ThirdPartyClientRecord = { clientId: string; name: string; redirectUris: string[] };

export type CachedClient =
  | { status: 'blocked' }
  | {
      status: 'active';
      record: ThirdPartyClientRecord;
      etag: string | null;
      /** Whether the copy is inside its cache time; a stale copy is revalidated first. */
      fresh: boolean;
    };

export type SaveClientInput = {
  clientId: string;
  metadata: ClientMetadata;
  etag: string | null;
  cacheSeconds: number;
};

export type GrantConsentInput = {
  environment: UtsEnvironment;
  sessionTokenHash: Uint8Array;
  clientId: string;
  orgId: string | null;
  /** A canonical scope set: unique and in ascending byte order. */
  scopes: readonly string[];
};

export type GrantConsentResult =
  | { outcome: 'granted'; consentId: string }
  | { outcome: 'no_session' | 'unknown_client' | 'org_denied' | 'gate_required' };

export type FindConsentInput = {
  accountId: string;
  clientId: string;
  orgId: string | null;
  scopes: readonly string[];
};

export type ConsentListing = {
  consentId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  orgId: string | null;
  grantedAt: Date;
};

export type WithdrawConsentInput = {
  environment: UtsEnvironment;
  sessionTokenHash: Uint8Array;
  consentId: string;
};

/** The outcome and the feed entries of the families the statement ended, which the caller publishes. */
export type WithdrawConsentResult =
  | { outcome: 'withdrawn'; endedFamilies: number; feedEntries: FeedEntry[] }
  | { outcome: 'not_found' }
  | { outcome: 'no_session' };

export type ThirdPartyStore = {
  /** The cached client, or null when UTS has never stored one under this id. */
  readClient(clientId: string): Promise<CachedClient | null>;
  /**
   * Stores a fetched document. A blocked client keeps its status and its old document, and
   * answers `blocked`.
   */
  saveClient(input: SaveClientInput): Promise<CachedClient>;
  /** Moves the cache time of a document its host revalidated with `304`. */
  extendClient(clientId: string, cacheSeconds: number): Promise<void>;
  /** The active consent of the account that covers every scope, or null. */
  findConsent(input: FindConsentInput): Promise<string | null>;
  grantConsent(input: GrantConsentInput): Promise<GrantConsentResult>;
  /** The active consents of the account the session cookie names; null without a live session. */
  listConsents(sessionTokenHash: Uint8Array): Promise<ConsentListing[] | null>;
  withdrawConsent(input: WithdrawConsentInput): Promise<WithdrawConsentResult>;
};

export type ThirdPartyAccess = <Result>(
  work: (store: ThirdPartyStore) => Promise<Result>
) => Promise<Result>;

const ClientRowSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('blocked') }),
  z.object({
    status: z.literal('active'),
    client_name: z.string(),
    redirect_uris: z.array(z.string()).min(1),
    etag: z.string().nullable(),
    fresh: z.boolean(),
  }),
]);

const ConsentIdRowSchema = z.object({ id: z.uuid() });

const GrantConsentRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('granted'), consent_id: z.uuid() }),
  z.object({ outcome: z.enum(['no_session', 'unknown_client', 'org_denied', 'gate_required']) }),
]);

const ConsentListingRowSchema = z.object({
  consent_id: z.uuid(),
  client_id: z.string(),
  client_name: z.string(),
  scopes: z.array(z.string()).min(1),
  org_id: z.uuid().nullable(),
  granted_at: z.date(),
});

/** The one row of a live session without consents. */
const EmptyListingRowSchema = z.object({ consent_id: z.null() });

const WithdrawRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('withdrawn'),
    ended_families: z.number().int().nonnegative(),
    feed_entries: StatementFeedEntriesSchema,
  }),
  z.object({ outcome: z.enum(['not_found', 'no_session']) }),
]);

function cachedClient(clientId: string, row: z.output<typeof ClientRowSchema>): CachedClient {
  if (row.status === 'blocked') return { status: 'blocked' };
  return {
    status: 'active',
    record: { clientId, name: row.client_name, redirectUris: row.redirect_uris },
    etag: row.etag,
    fresh: row.fresh,
  };
}

/** Every third-party statement over one identity-store connection. */
export function identityStoreThirdParty(store: IdentityStore): ThirdPartyStore {
  async function one<Row extends z.ZodType>(
    text: string,
    values: readonly unknown[],
    row: Row
  ): Promise<z.output<Row>> {
    const result = await store.maybeOne({ text, values }, row);
    if (result === null) throw new Error('a third-party statement returned no row');
    return result;
  }

  return {
    async readClient(clientId) {
      const row = await store.maybeOne(
        {
          text: `SELECT status, client_name, redirect_uris, etag, cache_expires_at > now() AS fresh
                 FROM uts.third_party_clients WHERE client_id = $1`,
          values: [clientId],
        },
        ClientRowSchema
      );
      return row === null ? null : cachedClient(clientId, row);
    },

    async saveClient(input) {
      const row = await one(
        'SELECT * FROM uts.save_third_party_client($1, $2, $3, $4, $5, $6)',
        [
          input.clientId,
          input.metadata.client_name,
          input.metadata.redirect_uris,
          JSON.stringify(input.metadata),
          input.etag,
          input.cacheSeconds,
        ],
        ClientRowSchema
      );
      return cachedClient(input.clientId, row);
    },

    async extendClient(clientId, cacheSeconds) {
      await store.rows(
        {
          text: 'SELECT uts.extend_third_party_client($1, $2)',
          values: [clientId, cacheSeconds],
        },
        z.unknown()
      );
    },

    async findConsent(input) {
      const row = await store.maybeOne(
        {
          text: `SELECT consent.id FROM uts.third_party_consents AS consent
                 WHERE consent.account_id = $1
                   AND consent.client_id = $2
                   AND consent.org_id IS NOT DISTINCT FROM $3
                   AND consent.scopes @> $4::text[]
                   AND consent.status = 'active'
                 ORDER BY consent.granted_at DESC
                 LIMIT 1`,
          values: [input.accountId, input.clientId, input.orgId, input.scopes],
        },
        ConsentIdRowSchema
      );
      return row?.id ?? null;
    },

    async grantConsent(input) {
      const row = await one(
        'SELECT * FROM uts.grant_third_party_consent($1, $2, $3, $4, $5)',
        [input.environment, input.sessionTokenHash, input.clientId, input.orgId, input.scopes],
        GrantConsentRowSchema
      );
      return row.outcome === 'granted'
        ? { outcome: 'granted', consentId: row.consent_id }
        : { outcome: row.outcome };
    },

    async listConsents(sessionTokenHash) {
      // No row: no live session. A row of nulls: a live session without consents.
      const rows = await store.rows(
        {
          text: 'SELECT * FROM uts.list_third_party_consents($1)',
          values: [sessionTokenHash],
        },
        z.union([ConsentListingRowSchema, EmptyListingRowSchema])
      );
      if (rows.length === 0) return null;
      const listings: ConsentListing[] = [];
      for (const row of rows) {
        if (row.consent_id === null) continue;
        listings.push({
          consentId: row.consent_id,
          clientId: row.client_id,
          clientName: row.client_name,
          scopes: row.scopes,
          orgId: row.org_id,
          grantedAt: row.granted_at,
        });
      }
      return listings;
    },

    async withdrawConsent(input) {
      const row = await one(
        `SELECT result.*, CASE WHEN result.outcome = 'withdrawn'
           THEN uts.feed_entries_of_statement() ELSE '[]'::jsonb END AS feed_entries
         FROM uts.withdraw_third_party_consent($1, $2, $3) AS result`,
        [input.environment, input.sessionTokenHash, input.consentId],
        WithdrawRowSchema
      );
      return row.outcome === 'withdrawn'
        ? {
            outcome: 'withdrawn',
            endedFamilies: row.ended_families,
            feedEntries: row.feed_entries,
          }
        : { outcome: row.outcome };
    },
  };
}

/** Each call opens one identity-store connection for its work and closes it in the background. */
export function thirdPartyAccess(connectionString: string, context: WaitUntil): ThirdPartyAccess {
  return work =>
    withIdentityStore(connectionString, context, store => work(identityStoreThirdParty(store)));
}
