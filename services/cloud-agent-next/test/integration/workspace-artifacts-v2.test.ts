import { env, reset, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ControlPlaneSessionPeer,
  SandboxControlV2,
} from '../../src/control-plane/sandbox/sandbox-do.js';
import { writeRoute } from '../../src/control-plane/sandbox/routes.js';
import {
  allocation as allocationTable,
  workspaceArtifactOrphans,
  workspaceArtifacts,
} from '../../src/control-plane/sandbox/sqlite-schema.js';
import {
  WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
  WORKSPACE_ARTIFACT_RESERVATION_TTL_MS,
  WORKSPACE_ARTIFACT_RETENTION_MS,
  type WorkspaceArtifactIdentity,
} from '../../src/shared/workspace-artifacts.js';
import {
  createWorkspaceArtifactIndex,
  workspaceArtifactReservationKey,
} from '../../src/control-plane/sandbox/workspace-artifacts.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const artifactsBucket = (env as unknown as { WORKSPACE_ARTIFACTS_BUCKET: R2Bucket })
  .WORKSPACE_ARTIFACTS_BUCKET;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function newSandbox(sandboxId: string): DurableObjectStub<SandboxControlV2> {
  return sandboxes.get(sandboxes.idFromName(sandboxId));
}

function identity(
  sandboxId: string,
  allocationId = 'allocation-1',
  wrapperInstanceId = 'wrapper-1'
): WorkspaceArtifactIdentity {
  return { sandboxId, allocationId, wrapperInstanceId };
}

async function setAllocation(
  stub: DurableObjectStub<SandboxControlV2>,
  input: { state: 'connected' | 'disconnected'; allocationId: string; wrapperId: string }
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    db.update(allocationTable)
      .set({
        state: input.state,
        allocation_id: input.allocationId,
        wrapper_id: input.wrapperId,
      })
      .where(eq(allocationTable.id, 'current'))
      .run();
  });
}

async function rows(stub: DurableObjectStub<SandboxControlV2>) {
  return runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    return {
      artifacts: db.select().from(workspaceArtifacts).all(),
      orphans: db.select().from(workspaceArtifactOrphans).all(),
    };
  });
}

afterEach(async () => {
  await reset();
});

describe('workspace artifact index', () => {
  it('reserves, commits, lists, and deletes with an expected hash', async () => {
    const sandboxId = `artifacts_${crypto.randomUUID()}`;
    const stub = newSandbox(sandboxId);
    const who = identity(sandboxId);
    await setAllocation(stub, {
      state: 'connected',
      allocationId: 'allocation-1',
      wrapperId: 'wrapper-1',
    });

    const reserved = await stub.reserveWorkspaceArtifactUpload(who, {
      relativePath: 'reports/summary.pdf',
      sizeBytes: 12,
    });
    expect(reserved.status).toBe('ok');
    if (reserved.status !== 'ok') throw new Error('reserve failed');
    expect(reserved.objectKey.startsWith(`${sandboxId}/`)).toBe(true);
    expect((await rows(stub)).orphans.map(row => row.object_key)).toEqual([reserved.objectKey]);

    const committed = await stub.commitWorkspaceArtifact(who, {
      relativePath: 'reports/summary.pdf',
      objectKey: reserved.objectKey,
      contentHash: HASH_A,
      sizeBytes: 12,
      contentType: 'application/pdf',
    });
    expect(committed).toEqual({ status: 'committed', revision: 1 });

    const stored = await rows(stub);
    expect(stored.orphans).toEqual([]);
    expect(stored.artifacts).toHaveLength(1);
    expect(stored.artifacts[0]?.object_key).toBe(reserved.objectKey);

    const listed = await stub.listWorkspaceArtifacts();
    expect(listed.revision).toBe(1);
    expect(listed.entries).toEqual([
      {
        relativePath: 'reports/summary.pdf',
        contentHash: HASH_A,
        sizeBytes: 12,
        contentType: 'application/pdf',
        updatedAt: expect.any(Number),
        expiresAt: expect.any(Number),
      },
    ]);
    const entry = listed.entries[0];
    if (entry === undefined) throw new Error('missing entry');
    expect(entry.expiresAt - entry.updatedAt).toBe(WORKSPACE_ARTIFACT_RETENTION_MS);
    expect(await stub.getWorkspaceArtifact('reports/summary.pdf')).toEqual({
      objectKey: reserved.objectKey,
      entry,
    });

    const repeated = await stub.reserveWorkspaceArtifactUpload(who, {
      relativePath: 'reports/summary.pdf',
      sizeBytes: 12,
    });
    if (repeated.status !== 'ok') throw new Error('repeat reserve failed');
    expect(
      await stub.commitWorkspaceArtifact(who, {
        relativePath: 'reports/summary.pdf',
        objectKey: repeated.objectKey,
        contentHash: HASH_A,
        sizeBytes: 12,
        contentType: 'application/pdf',
      })
    ).toEqual({ status: 'unchanged', revision: 1 });
    expect((await rows(stub)).orphans.map(row => row.object_key)).toEqual([repeated.objectKey]);

    expect(
      await stub.deleteWorkspaceArtifact(who, {
        relativePath: 'reports/summary.pdf',
        expectedHash: HASH_B,
      })
    ).toEqual({ status: 'hash_mismatch', revision: 1 });
    expect(
      await stub.deleteWorkspaceArtifact(who, {
        relativePath: 'reports/summary.pdf',
        expectedHash: HASH_A,
      })
    ).toEqual({ status: 'deleted', revision: 2 });

    const afterDelete = await rows(stub);
    expect(afterDelete.artifacts).toEqual([]);
    expect(afterDelete.orphans.map(row => row.object_key).sort()).toEqual(
      [reserved.objectKey, repeated.objectKey].sort()
    );
    expect(await stub.listWorkspaceArtifacts()).toEqual({ revision: 2, entries: [] });
    expect(
      await stub.deleteWorkspaceArtifactForUser({
        relativePath: 'reports/summary.pdf',
        expectedHash: HASH_A,
      })
    ).toEqual({ status: 'absent', revision: 2 });
  });

  it('notifies every route in the workspace after a real index change', async () => {
    const sandboxId = `artifacts_${crypto.randomUUID()}`;
    const stub = newSandbox(sandboxId);
    const who = identity(sandboxId);
    await setAllocation(stub, {
      state: 'connected',
      allocationId: 'allocation-1',
      wrapperId: 'wrapper-1',
    });
    const sessionIds = [`workspace_${crypto.randomUUID()}`, `workspace_${crypto.randomUUID()}`];
    const received: Array<{ sessionId: string; revision: number }> = [];
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put('control_plane_owner', 'user_1');
      const db = drizzle(state.storage, { logger: false });
      for (const sessionId of sessionIds) {
        writeRoute(db, {
          sessionId,
          spec: {
            sessionId,
            kiloSessionId: `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`,
            directory: `/workspace/${sessionId}`,
            attemptId: 'attempt-1',
          },
          grant: null,
          credentialSource: null,
          environment: null,
          state: 'ready',
          attemptId: 'attempt-1',
          attemptDeadlineAt: 0,
          reason: null,
        });
      }
      instance.sessionPeerFor = (_ownerId, sessionId) =>
        ({
          onWorkspaceArtifactsChanged: async payload => {
            received.push({ sessionId, revision: payload.revision });
          },
        }) as unknown as ControlPlaneSessionPeer;
    });

    const reserved = await stub.reserveWorkspaceArtifactUpload(who, {
      relativePath: 'reports/summary.pdf',
      sizeBytes: 12,
    });
    if (reserved.status !== 'ok') throw new Error('reserve failed');
    expect(
      await stub.commitWorkspaceArtifact(who, {
        relativePath: 'reports/summary.pdf',
        objectKey: reserved.objectKey,
        contentHash: HASH_A,
        sizeBytes: 12,
        contentType: 'application/pdf',
      })
    ).toEqual({ status: 'committed', revision: 1 });

    await waitFor(() =>
      expect(received).toEqual(
        expect.arrayContaining(sessionIds.map(sessionId => ({ sessionId, revision: 1 })))
      )
    );
    expect(received).toHaveLength(sessionIds.length);

    const repeated = await stub.reserveWorkspaceArtifactUpload(who, {
      relativePath: 'reports/summary.pdf',
      sizeBytes: 12,
    });
    if (repeated.status !== 'ok') throw new Error('repeat reserve failed');
    expect(
      await stub.commitWorkspaceArtifact(who, {
        relativePath: 'reports/summary.pdf',
        objectKey: repeated.objectKey,
        contentHash: HASH_A,
        sizeBytes: 12,
        contentType: 'application/pdf',
      })
    ).toEqual({ status: 'unchanged', revision: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(received).toHaveLength(sessionIds.length);
  });

  it('returns not_connected for a transient disconnect and stale for a replaced identity', async () => {
    const sandboxId = `artifacts_${crypto.randomUUID()}`;
    const stub = newSandbox(sandboxId);
    const who = identity(sandboxId);
    await setAllocation(stub, {
      state: 'connected',
      allocationId: 'allocation-1',
      wrapperId: 'wrapper-1',
    });

    const reserved = await stub.reserveWorkspaceArtifactUpload(who, {
      relativePath: 'report.txt',
      sizeBytes: 4,
    });
    if (reserved.status !== 'ok') throw new Error('reserve failed');
    await setAllocation(stub, {
      state: 'disconnected',
      allocationId: 'allocation-1',
      wrapperId: 'wrapper-1',
    });

    expect(
      await stub.reserveWorkspaceArtifactUpload(who, {
        relativePath: 'other.txt',
        sizeBytes: 4,
      })
    ).toEqual({ status: 'not_connected' });
    expect(
      await stub.commitWorkspaceArtifact(who, {
        relativePath: 'report.txt',
        objectKey: reserved.objectKey,
        contentHash: HASH_A,
        sizeBytes: 4,
        contentType: 'text/plain',
      })
    ).toEqual({ status: 'not_connected' });
    expect(
      await stub.deleteWorkspaceArtifact(who, {
        relativePath: 'report.txt',
        expectedHash: HASH_A,
      })
    ).toEqual({ status: 'not_connected' });
    expect((await rows(stub)).artifacts).toEqual([]);

    await setAllocation(stub, {
      state: 'connected',
      allocationId: 'allocation-1',
      wrapperId: 'wrapper-1',
    });
    expect(
      await stub.commitWorkspaceArtifact(who, {
        relativePath: 'report.txt',
        objectKey: reserved.objectKey,
        contentHash: HASH_A,
        sizeBytes: 4,
        contentType: 'text/plain',
      })
    ).toEqual({ status: 'committed', revision: 1 });

    await setAllocation(stub, {
      state: 'connected',
      allocationId: 'allocation-2',
      wrapperId: 'wrapper-2',
    });
    expect(
      await stub.reserveWorkspaceArtifactUpload(who, {
        relativePath: 'other.txt',
        sizeBytes: 4,
      })
    ).toEqual({ status: 'stale' });
    expect(
      await stub.commitWorkspaceArtifact(who, {
        relativePath: 'report.txt',
        objectKey: reserved.objectKey,
        contentHash: HASH_A,
        sizeBytes: 4,
        contentType: 'text/plain',
      })
    ).toEqual({ status: 'stale' });
    expect(
      await stub.deleteWorkspaceArtifact(who, {
        relativePath: 'report.txt',
        expectedHash: HASH_A,
      })
    ).toEqual({ status: 'stale' });
  });

  it('prunes expired entries on index access and queues their objects', async () => {
    const sandboxId = `artifacts_${crypto.randomUUID()}`;
    const stub = newSandbox(sandboxId);
    const who = identity(sandboxId);
    await setAllocation(stub, {
      state: 'connected',
      allocationId: 'allocation-1',
      wrapperId: 'wrapper-1',
    });
    const reserved = await stub.reserveWorkspaceArtifactUpload(who, {
      relativePath: 'old.txt',
      sizeBytes: 4,
    });
    if (reserved.status !== 'ok') throw new Error('reserve failed');
    await stub.commitWorkspaceArtifact(who, {
      relativePath: 'old.txt',
      objectKey: reserved.objectKey,
      contentHash: HASH_A,
      sizeBytes: 4,
      contentType: 'text/plain',
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      db.update(workspaceArtifacts)
        .set({ updated_at: Date.now() - WORKSPACE_ARTIFACT_RETENTION_MS - 1 })
        .where(eq(workspaceArtifacts.relative_path, 'old.txt'))
        .run();
    });

    expect(await stub.listWorkspaceArtifacts()).toEqual({ revision: 2, entries: [] });
    expect(await stub.getWorkspaceArtifact('old.txt')).toBeNull();
    expect((await rows(stub)).orphans.map(row => row.object_key)).toEqual([reserved.objectKey]);
  });

  it('leaves a fresh reservation and its object for an in-flight commit', async () => {
    const sandboxId = `artifacts_${crypto.randomUUID()}`;
    const stub = newSandbox(sandboxId);
    const who = identity(sandboxId);
    await setAllocation(stub, {
      state: 'connected',
      allocationId: 'allocation-1',
      wrapperId: 'wrapper-1',
    });
    const reserved = await stub.reserveWorkspaceArtifactUpload(who, {
      relativePath: 'pending.txt',
      sizeBytes: 6,
    });
    if (reserved.status !== 'ok') throw new Error('reserve failed');
    await artifactsBucket.put(reserved.objectKey, 'pending');

    await runInDurableObject(stub, async instance => {
      await instance.alarm();
    });

    expect(await artifactsBucket.head(reserved.objectKey)).not.toBeNull();
    expect((await rows(stub)).orphans.map(row => row.object_key)).toEqual([reserved.objectKey]);
  });

  it('rejects an aged reservation and lets the alarm sweep its object', async () => {
    const sandboxId = `artifacts_${crypto.randomUUID()}`;
    const stub = newSandbox(sandboxId);
    const who = identity(sandboxId);
    await setAllocation(stub, {
      state: 'connected',
      allocationId: 'allocation-1',
      wrapperId: 'wrapper-1',
    });
    const reserved = await stub.reserveWorkspaceArtifactUpload(who, {
      relativePath: 'expired.txt',
      sizeBytes: 6,
    });
    if (reserved.status !== 'ok') throw new Error('reserve failed');
    await artifactsBucket.put(reserved.objectKey, 'expired');
    await runInDurableObject(stub, async (_instance, state) => {
      const key = workspaceArtifactReservationKey(reserved.objectKey);
      const reservation = state.storage.kv.get<{ expiresAt: number }>(key);
      if (reservation === undefined) throw new Error('missing reservation');
      state.storage.kv.put(key, { ...reservation, expiresAt: Date.now() - 1 });
    });

    expect(
      await stub.commitWorkspaceArtifact(who, {
        relativePath: 'expired.txt',
        objectKey: reserved.objectKey,
        contentHash: HASH_A,
        sizeBytes: 6,
        contentType: 'text/plain',
      })
    ).toEqual({ status: 'reservation_expired' });

    await runInDurableObject(stub, async instance => {
      await instance.alarm();
    });
    await vi.waitFor(async () => {
      expect(await artifactsBucket.head(reserved.objectKey)).toBeNull();
    });
    expect((await rows(stub)).orphans).toEqual([]);
  });

  it('rejects a commit whose reservation was already claimed by the sweep', async () => {
    const sandboxId = `artifacts_${crypto.randomUUID()}`;
    const stub = newSandbox(sandboxId);
    const who = identity(sandboxId);
    await setAllocation(stub, {
      state: 'connected',
      allocationId: 'allocation-1',
      wrapperId: 'wrapper-1',
    });
    const reserved = await stub.reserveWorkspaceArtifactUpload(who, {
      relativePath: 'claimed.txt',
      sizeBytes: 6,
    });
    if (reserved.status !== 'ok') throw new Error('reserve failed');
    await artifactsBucket.put(reserved.objectKey, 'claimed');

    const claimed = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const index = createWorkspaceArtifactIndex({
        db,
        storage: state.storage,
        sandboxId,
      });
      return index.claimOrphans(10, Date.now() + WORKSPACE_ARTIFACT_RESERVATION_TTL_MS + 1);
    });
    expect(claimed).toEqual([reserved.objectKey]);

    expect(
      await stub.commitWorkspaceArtifact(who, {
        relativePath: 'claimed.txt',
        objectKey: reserved.objectKey,
        contentHash: HASH_A,
        sizeBytes: 6,
        contentType: 'text/plain',
      })
    ).toEqual({ status: 'reservation_missing' });
    expect((await rows(stub)).artifacts).toEqual([]);
  });

  it('rejects a commit without a pending reservation', async () => {
    const sandboxId = `artifacts_${crypto.randomUUID()}`;
    const stub = newSandbox(sandboxId);
    const who = identity(sandboxId);
    await setAllocation(stub, {
      state: 'connected',
      allocationId: 'allocation-1',
      wrapperId: 'wrapper-1',
    });
    const reserved = await stub.reserveWorkspaceArtifactUpload(who, {
      relativePath: 'missing.txt',
      sizeBytes: 6,
    });
    if (reserved.status !== 'ok') throw new Error('reserve failed');
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.delete(workspaceArtifactReservationKey(reserved.objectKey));
    });

    expect(
      await stub.commitWorkspaceArtifact(who, {
        relativePath: 'missing.txt',
        objectKey: reserved.objectKey,
        contentHash: HASH_A,
        sizeBytes: 6,
        contentType: 'text/plain',
      })
    ).toEqual({ status: 'reservation_missing' });
    expect((await rows(stub)).artifacts).toEqual([]);
  });

  it('counts total bytes but allows an equal-size replacement at the quota boundary', async () => {
    const sandboxId = `artifacts_${crypto.randomUUID()}`;
    const stub = newSandbox(sandboxId);
    const who = identity(sandboxId);
    await setAllocation(stub, {
      state: 'connected',
      allocationId: 'allocation-1',
      wrapperId: 'wrapper-1',
    });

    const paths: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const relativePath = `bulk/${index}.bin`;
      paths.push(relativePath);
      const reserved = await stub.reserveWorkspaceArtifactUpload(who, {
        relativePath,
        sizeBytes: WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
      });
      if (reserved.status !== 'ok') throw new Error(`reserve ${index} failed`);
      const committed = await stub.commitWorkspaceArtifact(who, {
        relativePath,
        objectKey: reserved.objectKey,
        contentHash: `${index}`.padStart(64, '0'),
        sizeBytes: WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
        contentType: 'application/octet-stream',
      });
      expect(committed.status).toBe('committed');
    }

    const replacement = await stub.reserveWorkspaceArtifactUpload(who, {
      relativePath: paths[0] ?? '',
      sizeBytes: WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
    });
    if (replacement.status !== 'ok') throw new Error('replacement reserve failed');
    expect(
      await stub.commitWorkspaceArtifact(who, {
        relativePath: paths[0] ?? '',
        objectKey: replacement.objectKey,
        contentHash: HASH_B,
        sizeBytes: WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
        contentType: 'application/octet-stream',
      })
    ).toEqual({ status: 'committed', revision: 11 });

    expect(
      await stub.reserveWorkspaceArtifactUpload(who, {
        relativePath: 'bulk/overflow.bin',
        sizeBytes: WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
      })
    ).toEqual({ status: 'quota_exceeded' });
  });
});
