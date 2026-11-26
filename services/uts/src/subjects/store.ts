import type {
  AccountImportRequest,
  AppUserCreatedEvent,
  SubjectOperation,
  UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { IdentityStore } from '../db/client';
import { type FeedEntry, StatementFeedEntriesSchema } from '../revocation/entries';

/**
 * The identity-import, authority-sync and subject-operation statements (migration
 * `0014_identity_import_subject_operations.sql`). Each call is one SQL statement: a SECURITY
 * DEFINER function that writes its rows, its tombstone or operation record and its audit row
 * together, and returns the feed entries it wrote, which the caller publishes.
 */

/** The database spelling of each operation (`uts.subject_operation`). */
const DB_OPERATION: Readonly<Record<SubjectOperation, string>> = {
  revoke: 'revoke',
  unblock: 'unblock',
  'end-browser-sessions': 'end_browser_sessions',
  'end-device-sessions': 'end_device_sessions',
  'revoke-api-credentials': 'revoke_api_credentials',
};

/** Who called and what the app said, for every statement here. */
type Caller = { environment: UtsEnvironment; workload: string };

export type OperationInput = Caller & {
  operation: SubjectOperation;
  operationId: string;
  subject: string;
  reason: string;
  actor: string;
  sourceVersion: number;
};

export type OperationRow =
  | { outcome: 'applied' | 'already_applied' | 'no_subject'; feedEntries: FeedEntry[] }
  | { outcome: 'retry_later'; retryAfterSeconds: number }
  | { outcome: 'refused'; error: 'account_deleted' };

export type ImportInput = Caller & { request: AccountImportRequest; rpId: string };

export type ImportRow =
  | { outcome: 'imported' | 'already_imported' }
  | { outcome: 'retry_later'; error: 'sso_connection_unknown' }
  | {
      outcome: 'refused';
      error:
        | 'deleted'
        | 'stale'
        | 'identity_taken'
        | 'email_taken'
        | 'passkey_taken'
        | 'sso_authority_mismatch';
    };

type SyncCommon = Caller & { operationId: string; actor: string; sourceVersion: number };

export type EmailSyncInput = SyncCommon & { subject: string; primaryEmail: string };
export type MembershipSyncInput = SyncCommon & {
  subject: string;
  orgId: string;
  role: 'owner' | 'admin' | 'member' | 'billing_manager' | null;
};
export type SsoOrganizationSyncInput = SyncCommon & {
  orgId: string;
  workosOrganizationId: string;
  workosConnectionIds: readonly string[];
  enforcement: 'off' | 'optional' | 'required';
};

export type SyncRow =
  | { outcome: 'applied' | 'already_applied' | 'no_subject'; feedEntries: FeedEntry[] }
  | { outcome: 'refused'; error: 'email_taken' | 'connection_conflict' };

export type SubjectStore = {
  applyOperation(input: OperationInput): Promise<OperationRow>;
  importAccount(input: ImportInput): Promise<ImportRow>;
  syncPrimaryEmail(input: EmailSyncInput): Promise<SyncRow>;
  syncMembership(input: MembershipSyncInput): Promise<SyncRow>;
  syncSsoOrganization(input: SsoOrganizationSyncInput): Promise<SyncRow>;
  readAppEvents(limit: number): Promise<AppUserCreatedEvent[]>;
  ackAppEvents(eventIds: readonly string[]): Promise<number>;
};

/** Runs `work` with the subject store of one request's identity-store connection. */
export type SubjectAccess = <Result>(
  work: (store: SubjectStore) => Promise<Result>
) => Promise<Result>;

const OperationRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.enum(['applied', 'already_applied', 'no_subject']),
    feed_entries: StatementFeedEntriesSchema,
  }),
  z.object({
    outcome: z.literal('retry_later'),
    retry_after_seconds: z.number().int().min(1).max(60),
  }),
  z.object({ outcome: z.literal('refused'), error: z.literal('account_deleted') }),
]);

const ImportRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.enum(['imported', 'already_imported']) }),
  z.object({ outcome: z.literal('retry_later'), error: z.literal('sso_connection_unknown') }),
  z.object({
    outcome: z.literal('refused'),
    error: z.enum([
      'deleted',
      'stale',
      'identity_taken',
      'email_taken',
      'passkey_taken',
      'sso_authority_mismatch',
    ]),
  }),
]);

const EmailRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.enum(['applied', 'already_applied', 'no_subject']) }),
  z.object({ outcome: z.literal('refused'), error: z.literal('email_taken') }),
]);

const MembershipRowSchema = z.object({
  outcome: z.enum(['applied', 'already_applied', 'no_subject']),
  feed_entries: StatementFeedEntriesSchema,
});

const SsoRowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.enum(['applied', 'already_applied']) }),
  z.object({ outcome: z.literal('refused'), error: z.literal('connection_conflict') }),
]);

const AppEventRowSchema = z.object({
  event_id: z.uuid(),
  account_id: z.string(),
  primary_email: z.string(),
  occurred_at: z.date(),
});

const CountSchema = z.object({ acknowledged: z.number().int().nonnegative() });

/** Every subject statement over one identity-store connection. */
export function identityStoreSubjects(store: IdentityStore): SubjectStore {
  async function one<Row extends z.ZodType>(
    text: string,
    values: readonly unknown[],
    row: Row
  ): Promise<z.output<Row>> {
    const result = await store.maybeOne({ text, values }, row);
    if (result === null) throw new Error('a subject function returned no row');
    return result;
  }

  return {
    async applyOperation(input) {
      const row = await one(
        `SELECT result.outcome, result.error, result.retry_after_seconds, result.feed_entries
         FROM uts.apply_subject_operation($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
        [
          input.environment,
          input.operationId,
          DB_OPERATION[input.operation],
          input.subject,
          input.reason,
          input.actor,
          input.workload,
          input.sourceVersion,
        ],
        OperationRowSchema
      );
      switch (row.outcome) {
        case 'retry_later':
          return { outcome: 'retry_later', retryAfterSeconds: row.retry_after_seconds };
        case 'refused':
          return { outcome: 'refused', error: row.error };
        default:
          return { outcome: row.outcome, feedEntries: row.feed_entries };
      }
    },

    async importAccount({ environment, workload, request, rpId }) {
      return await one(
        'SELECT result.outcome, result.error FROM uts.import_account($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS result',
        [
          environment,
          workload,
          request.app_user_id,
          request.primary_email,
          request.status,
          JSON.stringify(request.verified_identities),
          request.sso_authority === null ? null : JSON.stringify(request.sso_authority),
          JSON.stringify(request.passkeys),
          rpId,
          request.source_version,
        ],
        ImportRowSchema
      );
    },

    async syncPrimaryEmail(input) {
      const row = await one(
        'SELECT result.outcome, result.error FROM uts.sync_primary_email($1, $2, $3, $4, $5, $6, $7) AS result',
        [
          input.environment,
          input.operationId,
          input.subject,
          input.primaryEmail,
          input.actor,
          input.workload,
          input.sourceVersion,
        ],
        EmailRowSchema
      );
      return row.outcome === 'refused' ? row : { outcome: row.outcome, feedEntries: [] };
    },

    async syncMembership(input) {
      const row = await one(
        'SELECT result.outcome, result.feed_entries FROM uts.sync_org_membership($1, $2, $3, $4, $5, $6, $7, $8) AS result',
        [
          input.environment,
          input.operationId,
          input.subject,
          input.orgId,
          input.role,
          input.actor,
          input.workload,
          input.sourceVersion,
        ],
        MembershipRowSchema
      );
      return { outcome: row.outcome, feedEntries: row.feed_entries };
    },

    async syncSsoOrganization(input) {
      const row = await one(
        'SELECT result.outcome, result.error FROM uts.sync_sso_organization($1, $2, $3, $4, $5, $6, $7, $8, $9) AS result',
        [
          input.environment,
          input.operationId,
          input.orgId,
          input.workosOrganizationId,
          input.workosConnectionIds,
          input.enforcement,
          input.actor,
          input.workload,
          input.sourceVersion,
        ],
        SsoRowSchema
      );
      return row.outcome === 'refused' ? row : { outcome: row.outcome, feedEntries: [] };
    },

    async readAppEvents(limit) {
      const rows = await store.rows(
        {
          text: 'SELECT event_id, account_id, primary_email, occurred_at FROM uts.read_app_account_events($1)',
          values: [limit],
        },
        AppEventRowSchema
      );
      return rows.map((row): AppUserCreatedEvent => ({
        event_id: row.event_id,
        type: 'user.created',
        occurred_at: row.occurred_at.toISOString(),
        account: { id: row.account_id, primary_email: row.primary_email },
      }));
    },

    async ackAppEvents(eventIds) {
      const row = await one(
        'SELECT uts.ack_app_account_events($1::uuid[]) AS acknowledged',
        [eventIds],
        CountSchema
      );
      return row.acknowledged;
    },
  };
}
