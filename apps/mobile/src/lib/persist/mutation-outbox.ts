import * as Sentry from '@sentry/react-native';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { chainSave } from '@/lib/hooks/save-chain';
import * as encryptedKv from '@/lib/persist/encrypted-kv';

/**
 * Persisted mutation outbox over the encrypted SQLCipher KV store (P1-E-40c).
 *
 * One row per mutation intent under scope `outbox:<userId>`, keyed by the
 * intent fingerprint, so a row is account-scoped and survives relaunch. Only
 * two taxonomies are ever persisted:
 *
 * - `safe-retry`: the mutation is idempotent under its `operationKey`, so a
 *   relaunch may reuse the stored key and re-submit safely (Cloud Agent
 *   session registration is the only current producer).
 * - `reconcile-first`: the mutation must be reconciled against the server
 *   before any re-submit; a relaunch surfaces a card instead of auto-POSTing
 *   (Security sync/dismiss/enable).
 *
 * `never-replay` is deliberately absent from the type and the validator: a
 * never-replay mutation is never enqueued.
 *
 * Writes are epoch-fenced and serialized per full storage key via `chainSave`
 * (the same bound + fence pattern as `drafts.ts`): a write queued before a
 * sign-out/sign-in never lands after the epoch moved. Every storage failure is
 * contained at this boundary, reported to Sentry, and swallowed — the outbox
 * is best-effort crash recovery, so a storage failure must never block the
 * mutation it protects.
 */

type OutboxTaxonomy = 'safe-retry' | 'reconcile-first';

export type OutboxRow = {
  taxonomy: OutboxTaxonomy;
  operationKey: string;
  fingerprint: string;
  /**
   * The producer's scope (e.g. a security-agent org id or `personal`). Present
   * on `reconcile-first` rows so a dashboard can filter to its own scope; a
   * `safe-retry` row (Cloud Agent session) has no scope.
   */
  scope?: string;
  input: unknown;
};

const OUTBOX_SCOPE_PREFIX = 'outbox:';

/** One user's outbox scope. Rows live as KV items under this scope. */
export function outboxScope(userId: string): string {
  return `${OUTBOX_SCOPE_PREFIX}${userId}`;
}

/** Runtime shape guard for a stored outbox row. */
export function isOutboxRow(value: unknown): value is OutboxRow {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.taxonomy === 'safe-retry' || record.taxonomy === 'reconcile-first') &&
    typeof record.operationKey === 'string' &&
    typeof record.fingerprint === 'string' &&
    (record.scope === undefined || typeof record.scope === 'string')
  );
}

function fullKey(userId: string, fingerprint: string): string {
  return `${outboxScope(userId)}\u0000${fingerprint}`;
}

const OUTBOX_READ_DISCARDED = 'outbox read discarded';
const OUTBOX_WRITE_FAILED = 'outbox write failed';

function reportOutboxFailure(report: {
  message: string;
  reason: string;
  userId: string;
  fingerprint: string;
}): void {
  Sentry.captureException(new Error(report.message), {
    level: 'warning',
    extra: {
      scope: outboxScope(report.userId),
      fingerprint: report.fingerprint,
      reason: report.reason,
    },
  });
}

/**
 * Persists one outbox row under `outbox:<userId>`, keyed by its fingerprint.
 * Epoch-fenced and serialized per full key. A storage failure is reported to
 * Sentry and swallowed, so the caller can always proceed to the mutation.
 */
export async function writeOutboxRow(userId: string, row: OutboxRow): Promise<void> {
  if (!userId) {
    return;
  }
  try {
    const serialized = JSON.stringify(row) as string | undefined;
    if (serialized === undefined) {
      reportOutboxFailure({
        message: 'outbox row cannot be serialized to JSON',
        reason: OUTBOX_WRITE_FAILED,
        userId,
        fingerprint: row.fingerprint,
      });
      return;
    }
    const epoch = currentAuthEpoch();
    await chainSave(fullKey(userId, row.fingerprint), async () => {
      if (!isCurrentAuthEpoch(epoch)) {
        return;
      }
      await encryptedKv.setItem(outboxScope(userId), row.fingerprint, serialized);
    });
  } catch (error) {
    reportOutboxFailure({
      message: error instanceof Error ? error.message : OUTBOX_WRITE_FAILED,
      reason: OUTBOX_WRITE_FAILED,
      userId,
      fingerprint: row.fingerprint,
    });
  }
}

/**
 * Loads one outbox row by fingerprint. Returns null when the key is absent or
 * the stored value is corrupt/unreadable or fails the shape guard; corruption
 * is reported to Sentry and treated as empty.
 */
export async function loadOutboxRow(
  userId: string,
  fingerprint: string
): Promise<OutboxRow | null> {
  if (!userId) {
    return null;
  }
  try {
    const raw = await encryptedKv.getItem(outboxScope(userId), fingerprint);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isOutboxRow(parsed)) {
      reportOutboxFailure({
        message: 'stored outbox row does not match its expected shape',
        reason: OUTBOX_READ_DISCARDED,
        userId,
        fingerprint,
      });
      return null;
    }
    return parsed;
  } catch (error) {
    reportOutboxFailure({
      message: error instanceof Error ? error.message : 'stored outbox row is not valid JSON',
      reason: OUTBOX_READ_DISCARDED,
      userId,
      fingerprint,
    });
    return null;
  }
}

/**
 * Removes one outbox row. Serialized behind any in-flight write for the same
 * key. Not epoch-fenced: removal is explicit settle intent and must work
 * regardless of auth transitions. Remove failures are reported to Sentry and
 * swallowed.
 */
export async function removeOutboxRow(userId: string, fingerprint: string): Promise<void> {
  if (!userId) {
    return;
  }
  try {
    await chainSave(fullKey(userId, fingerprint), async () => {
      await encryptedKv.removeItem(outboxScope(userId), fingerprint);
    });
  } catch (error) {
    reportOutboxFailure({
      message: error instanceof Error ? error.message : OUTBOX_WRITE_FAILED,
      reason: OUTBOX_WRITE_FAILED,
      userId,
      fingerprint,
    });
  }
}

/** Parses one raw stored value into a row, or null when corrupt/mismatched. */
function parseOutboxRow(raw: string): OutboxRow | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isOutboxRow(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Lists every outbox row for one user. Corrupt entries are skipped. A storage
 * failure returns an empty list and is reported to Sentry.
 */
export async function listOutboxRows(userId: string): Promise<OutboxRow[]> {
  if (!userId) {
    return [];
  }
  try {
    const entries = await encryptedKv.listEntries(outboxScope(userId));
    const raws = await Promise.all(
      entries.map(async entry => {
        const raw = await encryptedKv.getItem(outboxScope(userId), entry.k);
        return raw;
      })
    );
    return raws
      .filter((raw): raw is string => raw !== null)
      .map(raw => parseOutboxRow(raw))
      .filter((row): row is OutboxRow => row !== null);
  } catch (error) {
    reportOutboxFailure({
      message: error instanceof Error ? error.message : OUTBOX_WRITE_FAILED,
      reason: OUTBOX_WRITE_FAILED,
      userId,
      fingerprint: '<list>',
    });
    return [];
  }
}
