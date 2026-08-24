import * as Sentry from '@sentry/react-native';
import * as z from 'zod';
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

const outboxRowSchema = z.object({
  taxonomy: z.enum(['safe-retry', 'reconcile-first']),
  operationKey: z.string(),
  fingerprint: z.string(),
  scope: z.string().optional(),
  input: z.unknown(),
});

/** Runtime shape guard for a stored outbox row. */
export function isOutboxRow(value: unknown): value is OutboxRow {
  return outboxRowSchema.safeParse(value).success;
}

function fullKey(userId: string, fingerprint: string): string {
  return `${outboxScope(userId)}\u0000${fingerprint}`;
}

function reportOutboxFailure(
  error: unknown,
  operation: 'read' | 'write' | 'remove' | 'list',
  fingerprint?: string
): void {
  Sentry.captureException(error, {
    level: 'warning',
    tags: { 'error.subsystem': 'mutation-outbox', 'error.operation': operation },
    ...(fingerprint ? { fingerprint: [fingerprint] } : {}),
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
      reportOutboxFailure(
        new Error('outbox row cannot be serialized to JSON'),
        'write',
        'outbox-write-unsupported-row'
      );
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
    reportOutboxFailure(error, 'write');
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
      reportOutboxFailure(
        new Error('stored outbox row does not match its expected shape'),
        'read',
        'outbox-read-shape-mismatch'
      );
      return null;
    }
    return parsed;
  } catch (error) {
    reportOutboxFailure(error, 'read');
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
    reportOutboxFailure(error, 'remove');
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
 * failure returns `null` (reported to Sentry) so a caller can never read a
 * failed read as "no stored rows" and mint a fresh operation key over a row
 * whose mutation the server may already have accepted.
 */
export async function listOutboxRows(userId: string): Promise<OutboxRow[] | null> {
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
    reportOutboxFailure(error, 'list');
    return null;
  }
}
