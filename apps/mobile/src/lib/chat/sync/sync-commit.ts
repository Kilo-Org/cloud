import { classifyConflict, type NativeSyncPacket } from '@kilocode/cloud-agent-sdk';

import { applyPulled } from './sync-import';
import {
  freeze,
  type FrozenPacket,
  type SyncDeps,
  type UploadChatInput,
  type UploadOutcome,
} from './sync-protocol';
import { saveSyncRecord, syncRecordOf } from './sync-store';

/**
 * Committing a frozen packet: the receipt path, and what happens when the CAS
 * is lost (H4/H5). Split from the upload builder so each half is one story.
 */

export async function commitFrozen(args: {
  readonly deps: SyncDeps;
  readonly input: UploadChatInput;
  readonly serverId: string;
  readonly frozen: FrozenPacket;
  readonly mayRebatch: boolean;
}): Promise<UploadOutcome> {
  const { deps, input, serverId, frozen, mayRebatch } = args;
  const result = await deps.transport.commit(serverId, frozen.packet);
  if (result.type === 'committed') {
    saveSyncRecord(deps.db, input.sessionId, {
      phase: 'synced',
      outbox: null,
      acknowledged: result.receipt.through,
      ackBatch: result.receipt.batchID,
      ackDigest: result.receipt.digest,
      ackedSeq: frozen.maxSeq,
      maxSeq: frozen.maxSeq,
    });
    return { kind: 'synced', position: result.receipt.through };
  }
  if (result.type === 'deleted') {
    saveSyncRecord(deps.db, input.sessionId, { phase: 'deleted', outbox: null });
    await deps.forgetLocal(input.sessionId);
    return { kind: 'deleted' };
  }
  if (result.type === 'retryable') {
    saveSyncRecord(deps.db, input.sessionId, { phase: 'pending' });
    return { kind: 'pending' };
  }
  if (result.type === 'failed') {
    saveSyncRecord(deps.db, input.sessionId, { phase: 'pending' });
    return { kind: 'failed', code: result.code };
  }
  // The CAS was lost: superseded and conflict both resolve against a fresh pull.
  return resolveConflict({ deps, input, serverId, frozen, mayRebatch });
}

/** H5: pull, import, then fast-forward above the pulled max seq or park diverged. */
async function resolveConflict(args: {
  readonly deps: SyncDeps;
  readonly input: UploadChatInput;
  readonly serverId: string;
  readonly frozen: FrozenPacket;
  readonly mayRebatch: boolean;
}): Promise<UploadOutcome> {
  const { deps, input, serverId, frozen, mayRebatch } = args;
  const pulled = await deps.transport.pull(serverId);
  if (pulled.type === 'deleted') {
    saveSyncRecord(deps.db, input.sessionId, { phase: 'deleted', outbox: null });
    await deps.forgetLocal(input.sessionId);
    return { kind: 'deleted' };
  }
  if (pulled.type === 'not_found' || pulled.type === 'retryable') {
    return { kind: 'pending' };
  }
  if (pulled.type === 'failed') {
    return { kind: 'failed', code: pulled.code };
  }
  const snapshot = pulled.snapshot;
  const record = syncRecordOf(deps.db, input.sessionId);
  if (record === null) {
    return { kind: 'unknown-chat' };
  }
  const unacked = Object.values(record.messageMap)
    .filter(entry => entry.seq > record.ackedSeq && entry.seq > 0)
    .map(entry => ({ seq: entry.seq }));
  const verdict = classifyConflict(unacked, snapshot.maxSeq);
  await applyPulled({
    deps,
    sessionId: input.sessionId,
    serverId,
    snapshot,
    model: input.modelId,
  });
  if (verdict === 'diverged' || !mayRebatch) {
    saveSyncRecord(deps.db, input.sessionId, {
      phase: verdict === 'diverged' ? 'diverged' : 'pending',
      outbox: verdict === 'diverged' ? null : record.outbox,
    });
    return verdict === 'diverged' ? { kind: 'diverged' } : { kind: 'pending' };
  }
  // Fast-forward: the same changes above the pulled position, under a new
  // batch id, since `after` is part of what the receipt digests.
  const rebatched: NativeSyncPacket = {
    ...frozen.packet,
    batchID: deps.newBatchId(),
    after: snapshot.position,
    through: snapshot.position + frozen.packet.changes.length,
  };
  saveSyncRecord(deps.db, input.sessionId, {
    phase: 'pending',
    outbox: freeze(rebatched, frozen.maxSeq),
  });
  return commitFrozen({
    deps,
    input,
    serverId,
    frozen: { packet: rebatched, maxSeq: frozen.maxSeq },
    mayRebatch: false,
  });
}
