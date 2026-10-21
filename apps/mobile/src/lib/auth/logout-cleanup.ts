import * as SecureStore from '@/lib/auth/secure-store';
import { readStoredValueForUpdate } from '@/lib/auth/secure-store-value';
import * as Sentry from '@sentry/react-native';
import * as z from 'zod';

import { emitNotificationTokenUpdated, getDevicePushTokenOutcome } from '@/lib/notifications';
import { type ActivityTokenLifetime, getGlanceableDelivery } from '@/lib/glanceable/sink-registry';
import { chainSave } from '@/lib/hooks/save-chain';
import { readCachedUserId } from '@/lib/persist/read-cache';
import { queryClient } from '@/lib/query-client';
import { LOGOUT_CLEANUP_TOMBSTONE_KEY } from '@/lib/storage-keys';
import { trpcClient } from '@/lib/trpc';

/**
 * Safe-retry records for remote cleanup that failed at logout (DEC-01).
 *
 * One record is stored per account, keyed by `userId` (`null` while the
 * account identity is unknown). Every mutator reads the record list it is
 * about to change inside `chainSave`, so a logout, an account/org switch and
 * the reconciliation retry never race each other. A record is merged with the
 * obligations already pending for the same account, and a record written for
 * one account is never removed or rewritten while another account is handled.
 *
 * A failed device-session revoke is NOT retried. The device already destroyed
 * the refresh token locally, and the access token expires within 1 h, so the
 * orphaned row is dead — it only lingers in the session list until then. A
 * push token is different: an unregistered device keeps receiving
 * notifications for the signed-out account until the row is gone, which the
 * user sees.
 *
 * The record is written directly with `SecureStore.setItemAsync`, deliberately
 * NOT epoch-fenced: it must survive sign-out by design, and sign-out must
 * never delete it.
 */

/**
 * Every field is validated so a malformed record is discarded instead of being
 * interpreted as a different-account skip or driving unsafe remote cleanup.
 * `z.number()` rejects NaN and Infinity, so `failedAt` is always finite.
 *
 * `pushLookupPending` records a logout whose device push token could not be
 * read: reconciliation re-reads the stable device token then. `pushTokens`
 * holds every token value still waiting for an unregister, so a rotated token
 * is not dropped when a newer logout succeeds.
 */
const logoutCleanupRecordSchema = z.object({
  /** Account identity at logout, or null when it was unknown. */
  userId: z.string().nullable(),
  /** Push token values still awaiting unregister. */
  pushTokens: z.array(z.string()),
  /** The device push token could not be read at logout; re-read it later. */
  pushLookupPending: z.boolean(),
  /** Activity-token unregister (Live Activity / push-to-start) outstanding. */
  needsActivityUnregister: z.boolean(),
  /** The exact activity tokens captured at logout; retried verbatim. */
  activityTokens: z.array(z.string()),
  /** Epoch ms of the latest failed logout; records past 30 days are discarded. */
  failedAt: z.number(),
});

export type LogoutCleanupRecord = z.infer<typeof logoutCleanupRecordSchema>;

/** Account identity a record belongs to; null while it is unknown. */
type LogoutCleanupOwner = string | null;

/**
 * The pre-ownership record shape (a single object, one `pushToken`). It is
 * read as a one-record list so an obligation written by the previous version
 * survives the update; the next write persists the versioned list.
 */
const legacyLogoutCleanupRecordSchema = z.object({
  userId: z.string().nullable(),
  pushToken: z.string().nullable(),
  needsPushUnregister: z.boolean(),
  needsActivityUnregister: z.boolean().default(false),
  activityTokens: z.array(z.string()).default([]),
  failedAt: z.number(),
});

const LOGOUT_CLEANUP_STORE_VERSION = 2;

/** The versioned store envelope; its entries are validated one by one. */
const logoutCleanupStoreEnvelopeSchema = z.object({
  version: z.number(),
  records: z.array(z.unknown()),
});

/**
 * A read that feeds a read-modify-write keeps "nothing stored" and "could not
 * read" apart, so a mutation aborts instead of persisting a list derived from
 * a store it never read.
 */
export type LogoutCleanupStoreRead =
  | { readonly status: 'records'; readonly records: LogoutCleanupRecord[] }
  | { readonly status: 'unreadable' };

type ParsedJson = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function parseJson(raw: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function parseStoredRecords(raw: string | null): LogoutCleanupStoreRead {
  if (raw === null) {
    return { status: 'records', records: [] };
  }
  const parsed = parseJson(raw);
  if (!parsed.ok) {
    return { status: 'unreadable' };
  }
  const envelope = logoutCleanupStoreEnvelopeSchema.safeParse(parsed.value);
  if (envelope.success) {
    // An unknown store version may carry entries this build cannot interpret;
    // rewriting it would drop them.
    if (envelope.data.version !== LOGOUT_CLEANUP_STORE_VERSION) {
      return { status: 'unreadable' };
    }
    // Validate per entry: one malformed record must not discard the rest.
    const records: LogoutCleanupRecord[] = [];
    for (const entry of envelope.data.records) {
      const record = logoutCleanupRecordSchema.safeParse(entry);
      if (record.success) {
        records.push(record.data);
      }
    }
    return { status: 'records', records: dedupeByOwner(records) };
  }
  const legacy = legacyLogoutCleanupRecordSchema.safeParse(parsed.value);
  return legacy.success
    ? { status: 'records', records: [fromLegacyRecord(legacy.data)] }
    : { status: 'unreadable' };
}

function fromLegacyRecord(
  legacy: z.infer<typeof legacyLogoutCleanupRecordSchema>
): LogoutCleanupRecord {
  return {
    userId: legacy.userId,
    pushTokens: legacy.needsPushUnregister && legacy.pushToken !== null ? [legacy.pushToken] : [],
    pushLookupPending: legacy.needsPushUnregister && legacy.pushToken === null,
    needsActivityUnregister: legacy.needsActivityUnregister,
    activityTokens: legacy.activityTokens,
    failedAt: legacy.failedAt,
  };
}

/** One record per owner; the first valid entry for an owner wins. */
function dedupeByOwner(records: readonly LogoutCleanupRecord[]): LogoutCleanupRecord[] {
  const byOwner = new Map<string, LogoutCleanupRecord>();
  for (const record of records) {
    const key = record.userId ?? '';
    if (!byOwner.has(key)) {
      byOwner.set(key, record);
    }
  }
  return [...byOwner.values()];
}

/**
 * Reads the stored records for a read-modify-write. A failed keychain read, an
 * unparseable payload, or an unknown store version is `unreadable`: a caller
 * must then leave the key alone rather than persist a list derived from a
 * store it never read. A malformed entry inside the current version is
 * discarded on its own so the valid records survive.
 */
export async function readLogoutCleanupStore(): Promise<LogoutCleanupStoreRead> {
  const stored = await readStoredValueForUpdate(LOGOUT_CLEANUP_TOMBSTONE_KEY);
  if (stored.status === 'unreadable') {
    return { status: 'unreadable' };
  }
  return parseStoredRecords(stored.value);
}

/** Read-only view of the pending records; an unreadable store reads as none. */
export async function readLogoutCleanupRecords(): Promise<LogoutCleanupRecord[]> {
  const read = await readLogoutCleanupStore();
  return read.status === 'records' ? read.records : [];
}

function logoutCleanupRecordFor(
  records: readonly LogoutCleanupRecord[],
  owner: LogoutCleanupOwner
): LogoutCleanupRecord | null {
  return records.find(record => record.userId === owner) ?? null;
}

/** Whether the record still describes remote work to retry. */
export function hasLogoutCleanupObligation(record: LogoutCleanupRecord): boolean {
  return record.pushLookupPending || record.pushTokens.length > 0 || record.needsActivityUnregister;
}

/** Replaces only the record of the same owner; every other record is kept. */
function upsertLogoutCleanupRecord(
  records: readonly LogoutCleanupRecord[],
  record: LogoutCleanupRecord
): LogoutCleanupRecord[] {
  return [...records.filter(existing => existing.userId !== record.userId), record];
}

/** Removes only the record of `owner`; every other record is kept. */
function removeLogoutCleanupRecord(
  records: readonly LogoutCleanupRecord[],
  owner: LogoutCleanupOwner
): LogoutCleanupRecord[] {
  return records.filter(record => record.userId !== owner);
}

/**
 * Persists the record list, dropping records with nothing left to retry. An
 * empty list removes the key.
 *
 * Mutating callers must run read → change → write inside
 * `chainSave(LOGOUT_CLEANUP_TOMBSTONE_KEY)`; `chainLogoutCleanupRecords` does
 * that for standalone callers.
 */
export async function writeLogoutCleanupRecords(
  records: readonly LogoutCleanupRecord[]
): Promise<void> {
  const live = dedupeByOwner(records.filter(record => hasLogoutCleanupObligation(record)));
  if (live.length === 0) {
    await SecureStore.deleteItemAsync(LOGOUT_CLEANUP_TOMBSTONE_KEY);
    return;
  }
  await SecureStore.setItemAsync(
    LOGOUT_CLEANUP_TOMBSTONE_KEY,
    JSON.stringify({ version: LOGOUT_CLEANUP_STORE_VERSION, records: live })
  );
}

/**
 * Reads, changes and writes the record list as one serialized transaction with
 * the other logout-cleanup writers.
 */
async function chainLogoutCleanupRecords(
  mutate: (records: LogoutCleanupRecord[]) => LogoutCleanupRecord[]
): Promise<void> {
  await chainSave(LOGOUT_CLEANUP_TOMBSTONE_KEY, async () => {
    const read = await readLogoutCleanupStore();
    if (read.status === 'unreadable') {
      // Nothing safe to modify: keep the stored payload for a later read.
      return;
    }
    await writeLogoutCleanupRecords(mutate(read.records));
  });
}

function uniqueTokens(tokens: readonly string[]): string[] {
  return [...new Set(tokens)];
}

/**
 * Runs remote logout cleanup while the token owner still serves auth headers
 * (called by sign-out BEFORE the epoch bump and BEFORE any credential
 * deletion). It NEVER throws: every step is internally caught, so a remote
 * or storage failure can never block local sign-out.
 *
 * - Revokes the current device session and unregisters the device push token
 *   concurrently, bounded at 15 s each by the tRPC client's `deadlineFetch`.
 * - A failed revoke is not recorded: see the record type for why. A failed
 *   push or activity-token unregister is merged into this account's record; a
 *   fully successful one leaves this account's record only when no earlier
 *   obligation for it is still pending, and never touches another account's
 *   record.
 */
export async function runLogoutCleanup(): Promise<void> {
  try {
    const userId = readCachedUserId(queryClient);
    // Terminal blanking can already be retiring tokens. Finish its record
    // write before full logout merges into that same account's record.
    await awaitActivityCleanupSettled();

    // Push token outcome: 'none' → nothing to unregister; 'lookup-failed' →
    // a server row may exist, so reconciliation re-reads the stable device
    // token and the record marks the lookup as pending.
    let pushToken: string | null = null;
    let pushLookupFailed = false;
    try {
      const outcome = await getDevicePushTokenOutcome();
      if (outcome.kind === 'token') {
        pushToken = outcome.token;
      } else if (outcome.kind === 'lookup-failed') {
        pushLookupFailed = true;
      }
    } catch {
      // Defensive: the outcome function never throws by contract.
      pushLookupFailed = true;
    }

    // Unregister activity tokens (Live Activity / push-to-start) before the
    // device session revoke: the revoke ends this token's auth, so a later
    // delete can only answer 401. A failed unregister is recorded and retried
    // at the next authenticated opportunity against the recorded tokens only.
    const activityResult = await getGlanceableDelivery().unregisterTokens();
    const needsActivityUnregister = !activityResult.ok;

    const results = await Promise.allSettled([
      trpcClient.user.revokeCurrentDeviceSession.mutate(),
      pushToken
        ? trpcClient.user.unregisterPushToken.mutate({ token: pushToken })
        : Promise.resolve(),
    ]);

    const unregister = results[1];

    // A fulfilled unregister for a real token is a definitive outcome; emit
    // it. No emit when there is no token (nothing was unregistered).
    if (pushToken !== null && unregister.status === 'fulfilled') {
      emitNotificationTokenUpdated('unregistered');
    }

    const needsPushUnregister =
      pushLookupFailed || (pushToken !== null && unregister.status === 'rejected');

    try {
      await chainLogoutCleanupRecords(records => {
        const pending = logoutCleanupRecordFor(records, userId);
        const pushTokenHandled = pushToken !== null && unregister.status === 'fulfilled';
        const record: LogoutCleanupRecord = {
          userId,
          // Keep token values still owed by an earlier logout of this
          // account, minus the one this logout just unregistered.
          pushTokens: uniqueTokens([
            ...(pending?.pushTokens ?? []).filter(
              token => !(pushTokenHandled && token === pushToken)
            ),
            ...(needsPushUnregister && pushToken !== null ? [pushToken] : []),
          ]),
          // This logout read the device token (or its absence) again, so its
          // outcome supersedes an earlier unknown-token attempt.
          pushLookupPending: pushLookupFailed,
          needsActivityUnregister:
            needsActivityUnregister || (pending?.needsActivityUnregister ?? false),
          activityTokens: uniqueTokens([
            ...(pending?.needsActivityUnregister ? pending.activityTokens : []),
            ...(needsActivityUnregister ? activityResult.tokens : []),
          ]),
          failedAt: Date.now(),
        };
        return hasLogoutCleanupObligation(record)
          ? upsertLogoutCleanupRecord(records, record)
          : removeLogoutCleanupRecord(records, userId);
      });
    } catch (error) {
      // A record write failure is reported but never blocks logout: the push
      // row stays removable on the next successful unregister.
      Sentry.captureException(error, {
        tags: { 'error.subsystem': 'auth', 'error.operation': 'write_logout_tombstone' },
      });
    }
  } catch (error) {
    // Never throw by contract: an unexpected failure anywhere in the gather
    // phase must not abort sign-out.
    Sentry.captureException(error, {
      tags: { 'error.subsystem': 'auth', 'error.operation': 'run_logout_cleanup' },
    });
  }
}

let activityCleanupInFlight: Promise<void> | null = null;

/** Wait for scope cleanup, including its record write, before checking registration safety. */
export async function awaitActivityCleanupSettled(): Promise<void> {
  if (activityCleanupInFlight !== null) {
    await activityCleanupInFlight;
  }
}

/**
 * Unregister the recorded activity tokens (Live Activity / push-to-start) and
 * record a failure, WITHOUT revoking the device session or unregistering the
 * Expo push token (those are logout-only). Never throws by contract.
 *
 * Ordinary activity ends pass `activity` to preserve scope delivery. Account
 * switch (`signIn`) and org switch (`setOrganizationId`) retire the whole scope,
 * where the prior scope's activity tokens must stop receiving APNs before the
 * new scope registers its own. The cached user id is read before any switch
 * clears it, so a failed unregister records the prior account's identity —
 * the same ordering `runLogoutCleanup` relies on. A successful unregister
 * leaves every record untouched. A failure merges this account's pending push
 * cleanup and failed activity tokens so both survive a switch, and leaves the
 * other accounts' records untouched.
 */
export async function unregisterActivityTokensAndTombstone(
  lifetime: ActivityTokenLifetime = 'scope',
  activityToken?: Promise<string | null>
): Promise<void> {
  const previous = activityCleanupInFlight;
  const cleanup = (async () => {
    await Promise.all([previous, runActivityCleanup(previous, lifetime, activityToken)]);
  })();
  activityCleanupInFlight = cleanup;
  try {
    await cleanup;
  } finally {
    if (activityCleanupInFlight === cleanup) {
      activityCleanupInFlight = null;
    }
  }
}

async function runActivityCleanup(
  previous: Promise<void> | null,
  lifetime: ActivityTokenLifetime,
  activityToken?: Promise<string | null>
): Promise<void> {
  try {
    const userId = readCachedUserId(queryClient);
    // Start the unregister now to fence stale registration intent. Serialize
    // only the record merge behind earlier cleanup writes.
    const result = await getGlanceableDelivery().unregisterTokens(lifetime, activityToken);
    await previous;
    if (result.ok) {
      return;
    }
    // Reconciliation must finish with its captured record before this merge
    // adds obligations that its deletion or partial-success rewrite cannot see.
    await chainSave(LOGOUT_CLEANUP_TOMBSTONE_KEY, async () => {
      const read = await readLogoutCleanupStore();
      if (read.status === 'unreadable') {
        // Nothing safe to modify: keep the stored payload for a later read.
        return;
      }
      const records = read.records;
      const pending = logoutCleanupRecordFor(records, userId);
      await writeLogoutCleanupRecords(
        upsertLogoutCleanupRecord(records, {
          userId,
          pushTokens: pending?.pushTokens ?? [],
          pushLookupPending: pending?.pushLookupPending ?? false,
          needsActivityUnregister: true,
          activityTokens: uniqueTokens([
            ...(pending?.needsActivityUnregister ? pending.activityTokens : []),
            ...result.tokens,
          ]),
          failedAt: Date.now(),
        })
      );
    });
  } catch (error) {
    // Never throw: a failed unregister or record write must not block the
    // account or org switch.
    Sentry.captureException(error, {
      tags: {
        'error.subsystem': 'auth',
        'error.operation': 'unregister_activity_tokens',
      },
    });
  }
}
