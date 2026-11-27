import { z } from 'zod';
import type { ProviderAdapter } from '../../sandbox-control/provider.js';
import {
  snapshotProviderSchema,
  workspaceSnapshotIdentitySchema,
} from '../../sandbox-control/snapshots.js';
import type { RouteDatabase } from './routes.js';
import {
  deleteWorkspaceSnapshot,
  readWorkspaceSnapshot,
  sameWorkspaceSnapshotIdentity,
  WORKSPACE_SNAPSHOT_TTL_MS,
  writeWorkspaceSnapshot,
} from './workspace-snapshot.js';

const PREFIX = 'stopped-workspace-snapshot/';
const POLL_MS = 15_000;
const REQUEST_SETTLE_MS = 5 * 60_000;
const journalSchema = z.object({
  owner: workspaceSnapshotIdentitySchema,
  allocationId: z.uuid(),
  runtimeIdentity: z.string(),
  ref: z.string(),
  provider: snapshotProviderSchema,
  stage: z.enum(['stopping', 'capturing', 'published', 'discarding']),
  dueAt: z.number(),
});
type Journal = z.infer<typeof journalSchema>;
type SnapshotProvider = NonNullable<ProviderAdapter['workspaceSnapshots']>;

export function stoppedWorkspaceSnapshots(db: RouteDatabase, storage: DurableObjectStorage) {
  const read = (key: string) => journalSchema.optional().parse(storage.kv.get(key));
  const entries = () =>
    [...storage.kv.list({ prefix: PREFIX })].map(([key, raw]) => ({
      key,
      job: journalSchema.parse(raw),
    }));
  function put(key: string, job: Journal) {
    storage.kv.put(key, job);
  }
  function discard(key: string, job: Journal) {
    const dueAt = job.stage === 'stopping' ? job.dueAt : Date.now();
    put(key, { ...job, stage: 'discarding', dueAt });
  }
  return {
    prepare(input: Omit<Journal, 'stage' | 'dueAt'>) {
      if (
        entries().some(
          ({ job }) => job.stage === 'stopping' && job.allocationId === input.allocationId
        )
      )
        return;
      const key = PREFIX + crypto.randomUUID();
      put(key, { ...input, stage: 'stopping', dueAt: Date.now() + REQUEST_SETTLE_MS });
    },
    /** Hold the stop until AWS accepted capture, even when the initial response was lost. */
    async start(provider: SnapshotProvider | undefined, ref: string | null) {
      if (!provider?.stoppedCapture || !ref) return true;
      const entry = entries().find(({ job }) => job.ref === ref && job.stage === 'stopping');
      if (!entry || entry.job.provider !== provider.provider) return true;
      const { key, job } = entry;
      const state = await provider.stoppedCapture.start(ref, key.slice(PREFIX.length));
      if (read(key)?.stage !== 'stopping') return true;
      if (state === 'uncertain' && job.dueAt > Date.now()) return false;
      if (state === 'accepted') put(key, { ...job, stage: 'capturing', dueAt: Date.now() });
      else discard(key, job);
      return true;
    },
    /** An explicit workspace deletion or reset cancels unpublished data and deletes published data. */
    remove(workspaceId: string) {
      for (const { key, job } of entries()) {
        if (job.owner.workspaceId === workspaceId) discard(key, job);
      }
    },
    awaitingCaptureStart() {
      return entries().some(({ job }) => job.stage === 'stopping' && job.dueAt > Date.now());
    },
    nextAlarmAt() {
      const times = entries().map(({ job }) => job.dueAt);
      return times.length ? Math.min(...times) : null;
    },
    async reconcile(provider: SnapshotProvider | undefined, publish: () => Promise<void>) {
      if (!provider?.stoppedCapture) return;
      const capture = provider.stoppedCapture;
      const entry = entries().find(
        ({ job }) => job.dueAt <= Date.now() && job.provider === provider.provider
      );
      if (!entry) return;
      const { key, job } = entry;
      const captureId = key.slice(PREFIX.length);
      if (job.stage === 'stopping' || job.stage === 'published') {
        if (readWorkspaceSnapshot(db, job.owner.workspaceId)?.captureId === captureId)
          deleteWorkspaceSnapshot(db, job.owner.workspaceId, 'expired');
        discard(key, job);
        return;
      }
      // Back off durably before the external call. Explicit deletion can supersede this entry.
      const retryAt = Date.now() + POLL_MS;
      put(key, { ...job, dueAt: retryAt });
      if (job.stage === 'discarding') {
        if ((await capture.discard(captureId)) === 'done') storage.kv.delete(key);
        return;
      }
      const result = await capture.poll(captureId);
      if (read(key)?.stage !== 'capturing' || result.status === 'in_progress') return;
      if (result.status === 'failed') {
        discard(key, job);
        return;
      }
      const previous = readWorkspaceSnapshot(db, job.owner.workspaceId);
      if (
        previous &&
        (!sameWorkspaceSnapshotIdentity(previous, job.owner) ||
          previous.capturedAt > result.capturedAt)
      ) {
        discard(key, job);
        return;
      }
      storage.transactionSync(() => {
        writeWorkspaceSnapshot(db, {
          ...job.owner,
          captureId,
          provider: job.provider,
          sourceAllocationId: job.allocationId,
          runtimeIdentity: job.runtimeIdentity,
          snapshotId: result.snapshotId,
          baseImage: result.baseImage,
          capturedAt: result.capturedAt,
        });
        put(key, {
          ...job,
          stage: 'published',
          dueAt: result.capturedAt + WORKSPACE_SNAPSHOT_TTL_MS,
        });
        if (previous?.captureId && previous.captureId !== captureId) {
          const priorKey = PREFIX + previous.captureId;
          const prior = read(priorKey);
          if (prior) discard(priorKey, prior);
        }
      });
      await publish();
    },
  };
}
