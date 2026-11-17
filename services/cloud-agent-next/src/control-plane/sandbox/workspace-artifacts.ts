import { asc, count, eq, inArray, lte } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/durable-sqlite';
import { z } from 'zod';
import {
  validateWorkspaceArtifactPath,
  workspaceArtifactCommitInputSchema,
  workspaceArtifactDeleteInputSchema,
  workspaceArtifactObjectKey,
  workspaceArtifactReserveInputSchema,
  WORKSPACE_ARTIFACT_MAX_ACTIVE_RESERVATIONS,
  WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
  WORKSPACE_ARTIFACT_MAX_FILES,
  WORKSPACE_ARTIFACT_MAX_TOTAL_BYTES,
  WORKSPACE_ARTIFACT_RESERVATION_TTL_MS,
  WORKSPACE_ARTIFACT_RETENTION_MS,
  type CommitWorkspaceArtifactResult,
  type DeleteWorkspaceArtifactForUserResult,
  type ReserveWorkspaceArtifactUploadResult,
  type WorkspaceArtifactCommitInput,
  type WorkspaceArtifactEntry,
  type WorkspaceArtifactEntryLookup,
  type WorkspaceArtifactList,
  type WorkspaceArtifactReserveInput,
} from '../../shared/workspace-artifacts.js';
import { workspaceArtifactOrphans, workspaceArtifacts } from './sqlite-schema.js';

export const WORKSPACE_ARTIFACT_REVISION_KEY = 'workspace_artifacts_revision';
const WORKSPACE_ARTIFACT_RESERVATION_PREFIX = 'workspace_artifact_reservation:';

const workspaceArtifactReservationSchema = z
  .object({
    sandboxId: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
    // Optional only so reservations written before this field still parse.
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

type WorkspaceArtifactReservation = z.infer<typeof workspaceArtifactReservationSchema>;

export function workspaceArtifactReservationKey(objectKey: string): string {
  return `${WORKSPACE_ARTIFACT_RESERVATION_PREFIX}${objectKey}`;
}

export type WorkspaceArtifactDatabase = ReturnType<typeof drizzle>;
type WorkspaceArtifactTransaction = Parameters<
  Parameters<WorkspaceArtifactDatabase['transaction']>[0]
>[0];

export type WorkspaceArtifactIndex = ReturnType<typeof createWorkspaceArtifactIndex>;

type Outcome<T> = { result: T; revision: number; changed: boolean };

export function createWorkspaceArtifactIndex(input: {
  db: WorkspaceArtifactDatabase;
  storage: Pick<DurableObjectStorage, 'kv'>;
  sandboxId: string;
  now?: () => number;
  onChanged?: (revision: number) => void;
}) {
  const now = input.now ?? Date.now;

  function revision(): number {
    const stored = input.storage.kv.get<number>(WORKSPACE_ARTIFACT_REVISION_KEY);
    return typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  }

  function bumpRevision(): number {
    const next = revision() + 1;
    if (!Number.isSafeInteger(next)) throw new Error('Workspace artifact revision exhausted');
    input.storage.kv.put(WORKSPACE_ARTIFACT_REVISION_KEY, next);
    return next;
  }

  function writeOrphan(tx: WorkspaceArtifactTransaction, objectKey: string, at: number): void {
    tx.insert(workspaceArtifactOrphans)
      .values({ object_key: objectKey, queued_at: at })
      .onConflictDoNothing()
      .run();
  }

  function readReservation(objectKey: string): WorkspaceArtifactReservation | null {
    const parsed = workspaceArtifactReservationSchema.safeParse(
      input.storage.kv.get(workspaceArtifactReservationKey(objectKey))
    );
    return parsed.success ? parsed.data : null;
  }

  function writeReservation(objectKey: string, at: number, sizeBytes: number): void {
    input.storage.kv.put(workspaceArtifactReservationKey(objectKey), {
      sandboxId: input.sandboxId,
      expiresAt: at + WORKSPACE_ARTIFACT_RESERVATION_TTL_MS,
      sizeBytes,
    } satisfies WorkspaceArtifactReservation);
  }

  /** Uploads that may still be streaming into the bucket; they hold storage before commit. */
  function activeReservations(at: number): { count: number; bytes: number } {
    let active = 0;
    let bytes = 0;
    for (const [, value] of input.storage.kv.list<unknown>({
      prefix: WORKSPACE_ARTIFACT_RESERVATION_PREFIX,
    })) {
      const parsed = workspaceArtifactReservationSchema.safeParse(value);
      if (!parsed.success || parsed.data.expiresAt <= at) continue;
      active += 1;
      bytes += parsed.data.sizeBytes ?? WORKSPACE_ARTIFACT_MAX_FILE_BYTES;
    }
    return { count: active, bytes };
  }

  function deleteReservation(objectKey: string): void {
    input.storage.kv.delete(workspaceArtifactReservationKey(objectKey));
  }

  function hasOrphan(tx: WorkspaceArtifactTransaction, objectKey: string): boolean {
    return (
      tx
        .select({ objectKey: workspaceArtifactOrphans.object_key })
        .from(workspaceArtifactOrphans)
        .where(eq(workspaceArtifactOrphans.object_key, objectKey))
        .get() !== undefined
    );
  }

  function pruneExpired(tx: WorkspaceArtifactTransaction, at: number): number {
    const before = revision();
    const cutoff = at - WORKSPACE_ARTIFACT_RETENTION_MS;
    const expired = tx
      .select({ objectKey: workspaceArtifacts.object_key })
      .from(workspaceArtifacts)
      .where(lte(workspaceArtifacts.updated_at, cutoff))
      .all();
    if (expired.length === 0) return before;
    for (const row of expired) writeOrphan(tx, row.objectKey, at);
    tx.delete(workspaceArtifacts).where(lte(workspaceArtifacts.updated_at, cutoff)).run();
    return bumpRevision();
  }

  function entryFromRow(row: typeof workspaceArtifacts.$inferSelect): WorkspaceArtifactEntry {
    return {
      relativePath: row.relative_path,
      contentHash: row.content_hash,
      sizeBytes: row.size_bytes,
      contentType: row.content_type,
      updatedAt: row.updated_at,
      expiresAt: row.updated_at + WORKSPACE_ARTIFACT_RETENTION_MS,
    };
  }

  function totals(tx: WorkspaceArtifactTransaction): { count: number; bytes: number } {
    const rows = tx
      .select({ sizeBytes: workspaceArtifacts.size_bytes })
      .from(workspaceArtifacts)
      .all();
    return {
      count: rows.length,
      bytes: rows.reduce((total, row) => total + row.sizeBytes, 0),
    };
  }

  function withinQuota(
    tx: WorkspaceArtifactTransaction,
    sizeBytes: number,
    previousSizeBytes: number | null,
    reservedBytes = 0
  ): boolean {
    if (previousSizeBytes !== null && sizeBytes <= previousSizeBytes && reservedBytes === 0) {
      return true;
    }
    const current = totals(tx);
    if (previousSizeBytes === null && current.count + 1 > WORKSPACE_ARTIFACT_MAX_FILES)
      return false;
    const growth = Math.max(0, sizeBytes - (previousSizeBytes ?? 0));
    return current.bytes + reservedBytes + growth <= WORKSPACE_ARTIFACT_MAX_TOTAL_BYTES;
  }

  function queuedOrphanCount(tx: WorkspaceArtifactTransaction): number {
    return tx.select({ value: count() }).from(workspaceArtifactOrphans).get()?.value ?? 0;
  }

  function withinReservationQuota(
    tx: WorkspaceArtifactTransaction,
    replacesExistingPath: boolean
  ): boolean {
    const queued = queuedOrphanCount(tx);
    if (queued >= WORKSPACE_ARTIFACT_MAX_FILES) return false;
    if (replacesExistingPath) return true;
    return totals(tx).count + queued < WORKSPACE_ARTIFACT_MAX_FILES;
  }

  function finish<T>(outcome: Outcome<T>): T {
    if (outcome.changed) input.onChanged?.(outcome.revision);
    return outcome.result;
  }

  function clearRows(): number {
    return input.db.transaction(tx => {
      const queued = tx
        .select({ objectKey: workspaceArtifactOrphans.object_key })
        .from(workspaceArtifactOrphans)
        .all();
      for (const row of queued) deleteReservation(row.objectKey);
      const rows = tx
        .select({ objectKey: workspaceArtifacts.object_key })
        .from(workspaceArtifacts)
        .all();
      if (rows.length === 0) return 0;
      const at = now();
      for (const row of rows) writeOrphan(tx, row.objectKey, at);
      tx.delete(workspaceArtifacts).run();
      bumpRevision();
      return rows.length;
    });
  }

  return {
    reserve(reserveInput: WorkspaceArtifactReserveInput): ReserveWorkspaceArtifactUploadResult {
      const path = validateWorkspaceArtifactPath(reserveInput.relativePath);
      if (!path.ok) return { status: 'invalid_path' };
      if (
        !Number.isSafeInteger(reserveInput.sizeBytes) ||
        reserveInput.sizeBytes < 0 ||
        reserveInput.sizeBytes > WORKSPACE_ARTIFACT_MAX_FILE_BYTES
      ) {
        return { status: 'quota_exceeded' };
      }
      const parsed = workspaceArtifactReserveInputSchema.safeParse(reserveInput);
      if (!parsed.success) return { status: 'invalid_path' };
      const at = now();
      const outcome: Outcome<ReserveWorkspaceArtifactUploadResult> = input.db.transaction(tx => {
        const before = revision();
        const pruned = pruneExpired(tx, at);
        const existing = tx
          .select({ sizeBytes: workspaceArtifacts.size_bytes })
          .from(workspaceArtifacts)
          .where(eq(workspaceArtifacts.relative_path, parsed.data.relativePath))
          .get();
        const previousSizeBytes = existing?.sizeBytes ?? null;
        if (
          !withinQuota(tx, parsed.data.sizeBytes, previousSizeBytes) ||
          !withinReservationQuota(tx, existing !== undefined)
        ) {
          return {
            result: { status: 'quota_exceeded' },
            revision: pruned,
            changed: pruned !== before,
          };
        }
        // In-flight uploads already occupy bucket storage, so they count against
        // the byte quota. Exceeding it is transient: the caller retries later.
        const active = activeReservations(at);
        if (
          active.count >= WORKSPACE_ARTIFACT_MAX_ACTIVE_RESERVATIONS ||
          !withinQuota(tx, parsed.data.sizeBytes, previousSizeBytes, active.bytes)
        ) {
          return {
            result: { status: 'busy' },
            revision: pruned,
            changed: pruned !== before,
          };
        }
        const objectKey = workspaceArtifactObjectKey(input.sandboxId, crypto.randomUUID());
        writeOrphan(tx, objectKey, at);
        writeReservation(objectKey, at, parsed.data.sizeBytes);
        return {
          result: { status: 'ok', objectKey },
          revision: pruned,
          changed: pruned !== before,
        };
      });
      return finish(outcome);
    },

    commit(commitInput: WorkspaceArtifactCommitInput): CommitWorkspaceArtifactResult {
      const parsed = workspaceArtifactCommitInputSchema.safeParse(commitInput);
      if (!parsed.success) {
        return validateWorkspaceArtifactPath(commitInput.relativePath).ok
          ? { status: 'quota_exceeded' }
          : { status: 'invalid_path' };
      }
      const { relativePath, objectKey, contentHash, sizeBytes, contentType } = parsed.data;
      if (!objectKey.startsWith(`${input.sandboxId}/`)) return { status: 'invalid_path' };
      const at = now();
      const outcome: Outcome<CommitWorkspaceArtifactResult> = input.db.transaction(tx => {
        const before = revision();
        const pruned = pruneExpired(tx, at);
        const existing = tx
          .select()
          .from(workspaceArtifacts)
          .where(eq(workspaceArtifacts.relative_path, relativePath))
          .get();
        if (
          existing?.object_key === objectKey &&
          existing.content_hash === contentHash &&
          !hasOrphan(tx, objectKey)
        ) {
          deleteReservation(objectKey);
          tx.delete(workspaceArtifactOrphans)
            .where(eq(workspaceArtifactOrphans.object_key, objectKey))
            .run();
          return {
            result: { status: 'unchanged', revision: pruned },
            revision: pruned,
            changed: pruned !== before,
          };
        }
        const reservation = readReservation(objectKey);
        if (
          reservation === null ||
          reservation.sandboxId !== input.sandboxId ||
          !hasOrphan(tx, objectKey)
        ) {
          if (reservation !== null) deleteReservation(objectKey);
          return {
            result: { status: 'reservation_missing' },
            revision: pruned,
            changed: pruned !== before,
          };
        }
        if (reservation.expiresAt <= at) {
          // Leave the reservation for the alarm to claim and delete; deleting
          // it here would hide the expired object until the orphan grace.
          return {
            result: { status: 'reservation_expired' },
            revision: pruned,
            changed: pruned !== before,
          };
        }
        if (existing?.content_hash === contentHash) {
          deleteReservation(objectKey);
          if (existing.object_key === objectKey) {
            tx.delete(workspaceArtifactOrphans)
              .where(eq(workspaceArtifactOrphans.object_key, objectKey))
              .run();
          }
          return {
            result: { status: 'unchanged', revision: pruned },
            revision: pruned,
            changed: pruned !== before,
          };
        }
        if (!withinQuota(tx, sizeBytes, existing?.size_bytes ?? null)) {
          deleteReservation(objectKey);
          return {
            result: { status: 'quota_exceeded' },
            revision: pruned,
            changed: pruned !== before,
          };
        }
        if (existing !== undefined && existing.object_key !== objectKey) {
          writeOrphan(tx, existing.object_key, at);
        }
        deleteReservation(objectKey);
        tx.delete(workspaceArtifactOrphans)
          .where(eq(workspaceArtifactOrphans.object_key, objectKey))
          .run();
        tx.insert(workspaceArtifacts)
          .values({
            relative_path: relativePath,
            object_key: objectKey,
            content_hash: contentHash,
            size_bytes: sizeBytes,
            content_type: contentType,
            updated_at: at,
          })
          .onConflictDoUpdate({
            target: workspaceArtifacts.relative_path,
            set: {
              object_key: objectKey,
              content_hash: contentHash,
              size_bytes: sizeBytes,
              content_type: contentType,
              updated_at: at,
            },
          })
          .run();
        const next = bumpRevision();
        return {
          result: { status: 'committed', revision: next },
          revision: next,
          changed: true,
        };
      });
      return finish(outcome);
    },

    deleteForUser(deleteInput: {
      relativePath: string;
      expectedHash: string;
    }): DeleteWorkspaceArtifactForUserResult {
      const parsed = workspaceArtifactDeleteInputSchema.safeParse(deleteInput);
      if (!parsed.success) return { status: 'absent', revision: revision() };
      const at = now();
      const outcome: Outcome<DeleteWorkspaceArtifactForUserResult> = input.db.transaction(tx => {
        const before = revision();
        const pruned = pruneExpired(tx, at);
        const existing = tx
          .select()
          .from(workspaceArtifacts)
          .where(eq(workspaceArtifacts.relative_path, parsed.data.relativePath))
          .get();
        if (existing === undefined) {
          return {
            result: { status: 'absent', revision: pruned },
            revision: pruned,
            changed: pruned !== before,
          };
        }
        if (existing.content_hash !== parsed.data.expectedHash) {
          return {
            result: { status: 'hash_mismatch', revision: pruned },
            revision: pruned,
            changed: pruned !== before,
          };
        }
        writeOrphan(tx, existing.object_key, at);
        tx.delete(workspaceArtifacts)
          .where(eq(workspaceArtifacts.relative_path, parsed.data.relativePath))
          .run();
        const next = bumpRevision();
        return {
          result: { status: 'deleted', revision: next },
          revision: next,
          changed: true,
        };
      });
      return finish(outcome);
    },

    list(): WorkspaceArtifactList {
      const at = now();
      const outcome: Outcome<WorkspaceArtifactList> = input.db.transaction(tx => {
        const before = revision();
        const pruned = pruneExpired(tx, at);
        const entries = tx
          .select()
          .from(workspaceArtifacts)
          .orderBy(asc(workspaceArtifacts.relative_path))
          .all()
          .map(entryFromRow);
        return {
          result: { revision: pruned, entries },
          revision: pruned,
          changed: pruned !== before,
        };
      });
      return finish(outcome);
    },

    get(relativePath: string): WorkspaceArtifactEntryLookup | null {
      const at = now();
      const outcome: Outcome<WorkspaceArtifactEntryLookup | null> = input.db.transaction(tx => {
        const before = revision();
        const pruned = pruneExpired(tx, at);
        const row = tx
          .select()
          .from(workspaceArtifacts)
          .where(eq(workspaceArtifacts.relative_path, relativePath))
          .get();
        return {
          result:
            row === undefined ? null : { objectKey: row.object_key, entry: entryFromRow(row) },
          revision: pruned,
          changed: pruned !== before,
        };
      });
      return finish(outcome);
    },

    /**
     * Frees the active-upload slot of a reservation whose upload failed. The orphan
     * row stays, so the sweep still deletes anything storage kept.
     */
    release(objectKey: string): void {
      if (!objectKey.startsWith(`${input.sandboxId}/`)) return;
      if (readReservation(objectKey)?.sandboxId !== input.sandboxId) return;
      deleteReservation(objectKey);
    },

    clear(): number {
      return clearRows();
    },

    earliestOrphanAt(): number | null {
      const row = input.db
        .select({ queuedAt: workspaceArtifactOrphans.queued_at })
        .from(workspaceArtifactOrphans)
        .orderBy(asc(workspaceArtifactOrphans.queued_at))
        .limit(1)
        .get();
      return row?.queuedAt ?? null;
    },

    claimOrphans(limit: number, at: number): string[] {
      const rows = input.db
        .select({
          objectKey: workspaceArtifactOrphans.object_key,
          queuedAt: workspaceArtifactOrphans.queued_at,
        })
        .from(workspaceArtifactOrphans)
        .orderBy(asc(workspaceArtifactOrphans.queued_at))
        .limit(limit)
        .all();
      const claimed: string[] = [];
      for (const row of rows) {
        const reservation = readReservation(row.objectKey);
        if (reservation !== null) {
          if (reservation.expiresAt > at) continue;
          deleteReservation(row.objectKey);
        } else if (row.queuedAt > at - WORKSPACE_ARTIFACT_RESERVATION_TTL_MS) {
          continue;
        }
        claimed.push(row.objectKey);
      }
      return claimed;
    },

    removeOrphans(objectKeys: readonly string[]): void {
      if (objectKeys.length === 0) return;
      for (const objectKey of objectKeys) deleteReservation(objectKey);
      input.db
        .delete(workspaceArtifactOrphans)
        .where(inArray(workspaceArtifactOrphans.object_key, [...objectKeys]))
        .run();
    },
  };
}
