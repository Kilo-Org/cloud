import {
  type AccountImportAnswer,
  AccountImportRequestSchema,
  type AppUserCreatedEvent,
  type AuthorityAnswer,
  type AuthorityKind,
  EmailSyncRequestSchema,
  MembershipSyncRequestSchema,
  type SubjectOperation,
  SubjectOperationRequestSchema,
  type SubjectOperationResult,
  SsoOrganizationSyncRequestSchema,
  type UtsEnvironment,
  reasonAllowed,
} from '@kilocode/uts-contracts';
import { IdentityStoreError } from '../db/client';
import type { FeedPublish } from '../revocation/publish';
import type { SubjectAccess, SyncRow } from './store';

/**
 * The subject operations, the identity import and the authority syncs, shared by the HTTPS routes
 * (src/subjects/routes.ts) and the `SubjectRevocation` entrypoint (src/subjects/entrypoint.ts).
 * Each validates its body, runs one statement, and hands the feed entries the statement wrote to
 * the feed objects; it answers success only once a vouching feed object took them (design 5.6).
 */
export type SubjectDeps = {
  environment: UtsEnvironment;
  /** The relying-party id of imported passkeys: the app host (design 5.14). */
  rpId: string;
  subjects: SubjectAccess;
  publish: FeedPublish;
};

/** Seconds a caller waits after a store failure or a publish no feed object vouched for. */
export const RETRY_AFTER_SECONDS = 2;

/** The answer to a failure that no retry of the same request fixes, and to a retryable one. */
type Failure = { kind: 'invalid_request' } | { kind: 'unavailable'; retryAfterSeconds: number };

/**
 * A statement failure: a retryable store failure asks for a retry; `22023` (the statement refused
 * its input, such as an `operation_id` reused for another operation) is a caller error; anything
 * else is a bug and throws. The log line carries the SQLSTATE, never a value.
 */
function storeFailure(error: unknown, statement: string): Failure {
  if (!(error instanceof IdentityStoreError)) throw error;
  console.error(
    JSON.stringify({
      event: 'uts.subjects.store_failed',
      statement,
      failure: error.failure,
      sqlState: error.sqlState,
      systemCode: error.systemCode,
    })
  );
  if (error.failure === 'retryable') {
    return { kind: 'unavailable', retryAfterSeconds: RETRY_AFTER_SECONDS };
  }
  if (error.sqlState === '22023') return { kind: 'invalid_request' };
  throw error;
}

export async function runSubjectOperation(
  deps: SubjectDeps,
  operation: SubjectOperation,
  body: unknown,
  workload: string
): Promise<SubjectOperationResult> {
  const parsed = SubjectOperationRequestSchema.safeParse(body);
  if (!parsed.success) return { outcome: 'invalid_request' };
  const request = parsed.data;
  if (!reasonAllowed(operation, request.reason)) {
    return { outcome: 'refused', error: 'reason_not_allowed' };
  }
  let row;
  try {
    row = await deps.subjects(store =>
      store.applyOperation({
        environment: deps.environment,
        workload,
        operation,
        operationId: request.operation_id,
        subject: request.subject,
        reason: request.reason,
        actor: request.actor,
        sourceVersion: request.source_version,
      })
    );
  } catch (error) {
    const failure = storeFailure(error, `subjects.${operation}`);
    return failure.kind === 'invalid_request'
      ? { outcome: 'invalid_request' }
      : { outcome: 'unavailable', retryAfterSeconds: failure.retryAfterSeconds };
  }
  switch (row.outcome) {
    case 'retry_later':
      return {
        outcome: 'retry_later',
        error: 'unblock_too_soon',
        operationId: request.operation_id,
        retryAfterSeconds: row.retryAfterSeconds,
      };
    case 'refused':
      return { outcome: 'refused', error: row.error };
    default:
      if ((await deps.publish(row.feedEntries)) === 'unpublished') {
        return { outcome: 'unavailable', retryAfterSeconds: RETRY_AFTER_SECONDS };
      }
      return { outcome: row.outcome, operationId: request.operation_id };
  }
}

export type ImportResult =
  | AccountImportAnswer
  | { outcome: 'invalid_request' }
  | { outcome: 'unavailable'; retryAfterSeconds: number };

/** Seconds an import waits for the SSO sync it needs. */
export const SSO_SYNC_RETRY_SECONDS = 60;

export async function runAccountImport(
  deps: SubjectDeps,
  body: unknown,
  workload: string
): Promise<ImportResult> {
  const parsed = AccountImportRequestSchema.safeParse(body);
  if (!parsed.success) return { outcome: 'invalid_request' };
  const request = parsed.data;
  try {
    const row = await deps.subjects(store =>
      store.importAccount({ environment: deps.environment, workload, request, rpId: deps.rpId })
    );
    switch (row.outcome) {
      case 'imported':
      case 'already_imported':
        return { outcome: row.outcome, account_id: request.app_user_id };
      default:
        return row;
    }
  } catch (error) {
    const failure = storeFailure(error, 'accounts.import');
    return failure.kind === 'invalid_request'
      ? { outcome: 'invalid_request' }
      : { outcome: 'unavailable', retryAfterSeconds: failure.retryAfterSeconds };
  }
}

export type AuthorityResult =
  | AuthorityAnswer
  | { outcome: 'invalid_request' }
  | { outcome: 'unavailable'; retryAfterSeconds: number };

async function syncOf(
  deps: SubjectDeps,
  kind: AuthorityKind,
  body: unknown,
  workload: string
): Promise<{ operationId: string; row: SyncRow } | null> {
  const caller = { environment: deps.environment, workload };
  switch (kind) {
    case 'email': {
      const parsed = EmailSyncRequestSchema.safeParse(body);
      if (!parsed.success) return null;
      const request = parsed.data;
      const row = await deps.subjects(store =>
        store.syncPrimaryEmail({
          ...caller,
          operationId: request.operation_id,
          actor: request.actor,
          sourceVersion: request.source_version,
          subject: request.subject,
          primaryEmail: request.primary_email,
        })
      );
      return { operationId: request.operation_id, row };
    }
    case 'membership': {
      const parsed = MembershipSyncRequestSchema.safeParse(body);
      if (!parsed.success) return null;
      const request = parsed.data;
      const row = await deps.subjects(store =>
        store.syncMembership({
          ...caller,
          operationId: request.operation_id,
          actor: request.actor,
          sourceVersion: request.source_version,
          subject: request.subject,
          orgId: request.app_organization_id,
          role: request.role,
        })
      );
      return { operationId: request.operation_id, row };
    }
    case 'sso-organization': {
      const parsed = SsoOrganizationSyncRequestSchema.safeParse(body);
      if (!parsed.success) return null;
      const request = parsed.data;
      const row = await deps.subjects(store =>
        store.syncSsoOrganization({
          ...caller,
          operationId: request.operation_id,
          actor: request.actor,
          sourceVersion: request.source_version,
          orgId: request.app_organization_id,
          workosOrganizationId: request.workos_organization_id,
          workosConnectionIds: request.workos_connection_ids,
          enforcement: request.enforcement,
        })
      );
      return { operationId: request.operation_id, row };
    }
  }
}

export async function runAuthoritySync(
  deps: SubjectDeps,
  kind: AuthorityKind,
  body: unknown,
  workload: string
): Promise<AuthorityResult> {
  let synced;
  try {
    synced = await syncOf(deps, kind, body, workload);
  } catch (error) {
    const failure = storeFailure(error, `authority.${kind}`);
    return failure.kind === 'invalid_request'
      ? { outcome: 'invalid_request' }
      : { outcome: 'unavailable', retryAfterSeconds: failure.retryAfterSeconds };
  }
  if (synced === null) return { outcome: 'invalid_request' };
  const { operationId, row } = synced;
  if (row.outcome === 'refused') return row;
  if (row.outcome === 'retry_later') {
    return { outcome: 'retry_later', error: row.error, operation_id: operationId };
  }
  if ((await deps.publish(row.feedEntries)) === 'unpublished') {
    return { outcome: 'unavailable', retryAfterSeconds: RETRY_AFTER_SECONDS };
  }
  return { outcome: row.outcome, operation_id: operationId };
}

export type AppEventsResult =
  | { outcome: 'read'; events: AppUserCreatedEvent[] }
  | { outcome: 'acknowledged'; acknowledged: number }
  | { outcome: 'unavailable'; retryAfterSeconds: number };

export async function readAppEvents(deps: SubjectDeps, limit: number): Promise<AppEventsResult> {
  try {
    return { outcome: 'read', events: await deps.subjects(store => store.readAppEvents(limit)) };
  } catch (error) {
    const failure = storeFailure(error, 'app_events.read');
    if (failure.kind === 'invalid_request') throw error;
    return { outcome: 'unavailable', retryAfterSeconds: failure.retryAfterSeconds };
  }
}

export async function ackAppEvents(
  deps: SubjectDeps,
  eventIds: readonly string[]
): Promise<AppEventsResult> {
  try {
    return {
      outcome: 'acknowledged',
      acknowledged: await deps.subjects(store => store.ackAppEvents(eventIds)),
    };
  } catch (error) {
    const failure = storeFailure(error, 'app_events.ack');
    if (failure.kind === 'invalid_request') throw error;
    return { outcome: 'unavailable', retryAfterSeconds: failure.retryAfterSeconds };
  }
}
