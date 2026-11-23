import {
  encodeMessageChanges,
  encodeSessionEntity,
  type NativeSyncPacket,
  nextSeq,
} from '@kilocode/cloud-agent-sdk';
import type { Turn } from '@kilocode/harness-sdk';

import { commitFrozen } from './sync-commit';
import { imagePartsOf, turnsToPortable } from './sync-mapping';
import {
  base64ToBytes,
  freeze,
  sequenceNewTurns,
  sessionOf,
  thaw,
  type SyncDeps,
  type UploadChatInput,
  type UploadOutcome,
  type UploadedBlob,
} from './sync-protocol';
import { saveSyncRecord, stampServerSessionId, syncRecordOf, type SyncRecord } from './sync-store';

/**
 * The sync engine: register a chat, then upload its settled turns as one
 * frozen packet. The commit path and the conflict resolution live beside it
 * in `sync-commit`, the import path in `sync-import`, and the wire contract
 * in `sync-protocol`.
 */

export async function ensureRegistered(
  deps: SyncDeps,
  sessionId: string,
  sourceId: string
): Promise<
  | { readonly kind: 'ready'; readonly record: SyncRecord; readonly serverId: string }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'unknown-chat' }
> {
  const record = syncRecordOf(deps.db, sessionId);
  if (record === null) {
    return { kind: 'unknown-chat' };
  }
  if (record.phase === 'deleted') {
    return { kind: 'deleted' };
  }
  const serverId =
    record.serverSessionId ??
    stampServerSessionId({
      db: deps.db,
      sessionId,
      serverSessionId: deps.newServerSessionId(),
      sourceId,
    });
  if (record.serverSessionId !== null && record.phase !== 'local') {
    return { kind: 'ready', record, serverId };
  }
  const registered = await deps.transport.register(serverId, sourceId);
  switch (registered.type) {
    case 'registered': {
      saveSyncRecord(deps.db, sessionId, {
        sourceId,
        phase: record.outbox === null ? 'synced' : 'pending',
        acknowledged: Math.max(record.acknowledged, registered.position),
      });
      return { kind: 'ready', record: syncRecordOf(deps.db, sessionId) ?? record, serverId };
    }
    case 'deleted': {
      saveSyncRecord(deps.db, sessionId, { phase: 'deleted', outbox: null });
      return { kind: 'deleted' };
    }
    case 'retryable': {
      return { kind: 'pending' };
    }
    case 'failed': {
      return { kind: 'failed', code: registered.code };
    }
  }
}

/**
 * Uploads every mapped-but-unacknowledged turn of one chat as one frozen
 * packet. A conflict pulls, imports, then fast-forwards or parks diverged.
 */
export async function uploadChat(
  deps: SyncDeps,
  input: UploadChatInput
): Promise<UploadOutcome> {
  const ready = await ensureRegistered(deps, input.sessionId, input.sourceId);
  if (ready.kind !== 'ready') {
    if (ready.kind === 'deleted') {
      await deps.forgetLocal(input.sessionId);
      return { kind: 'deleted' };
    }
    return ready.kind === 'unknown-chat'
      ? { kind: 'unknown-chat' }
      : (ready.kind === 'pending'
        ? { kind: 'pending' }
        : { kind: 'failed', code: ready.code });
  }
  const { serverId } = ready;
  let record = ready.record;
  if (record.phase === 'diverged') {
    return { kind: 'diverged' };
  }
  // A frozen outbox that commits is the outcome, even when it carried the
  // chat's only pending messages: there is nothing left to send afterwards.
  let resentPosition: number | null = null;

  // A frozen outbox goes first, byte-identical: the server may already hold
  // it, and resending is how the acknowledgement is recovered.
  if (record.outbox !== null) {
    const frozen = thaw(record.outbox);
    if (frozen !== null) {
      const outcome = await commitFrozen({ deps, input, serverId, frozen, mayRebatch: false });
      if (outcome.kind !== 'synced') {
        return outcome;
      }
      resentPosition = outcome.position;
      record = syncRecordOf(deps.db, input.sessionId) ?? record;
    } else {
      saveSyncRecord(deps.db, input.sessionId, { outbox: null, phase: 'synced' });
      record = syncRecordOf(deps.db, input.sessionId) ?? record;
    }
  }

  const { sequenced, map, maxSeq } = sequenceNewTurns(record, input.turns);
  if (sequenced.length === 0 && input.metadataOnly !== true) {
    if (JSON.stringify(map) !== JSON.stringify(record.messageMap)) {
      saveSyncRecord(deps.db, input.sessionId, { messageMap: map });
    }
    return resentPosition === null
      ? { kind: 'nothing-to-upload' }
      : { kind: 'synced', position: resentPosition };
  }
  const now = deps.now();
  const lastAssistant = sequenced.at(-1)?.turn.role === 'assistant';
  const idleSeq = lastAssistant ? nextSeq(maxSeq, maxSeq) : null;
  const finalMaxSeq = idleSeq ?? maxSeq;

  const blobs = new Map<string, UploadedBlob>();
  for (const image of imagePartsOf(sequenced.map(one => one.turn))) {
    blobs.set(image.partId, await deps.transport.putBlob(serverId, base64ToBytes(image.base64), image.media));
  }
  const session = sessionOf({
    record,
    serverId,
    title: input.title,
    model: input.model,
    created: input.createdAt,
    now,
  });
  const messages = turnsToPortable(sequenced, {
    model: input.model,
    agent: input.agent,
    blobs,
    idleSeq,
    now,
  });
  // Parts carry the packet's `through` as their position, so encoding happens
  // once the count of changes is known. The count does not depend on the
  // value, so one throwaway encode answers it.
  const changeCount = 1 + encodeMessageChanges(messages, 0).length;
  const through = record.acknowledged + changeCount;
  const changes = [encodeSessionEntity(session), ...encodeMessageChanges(messages, through)];
  const packet: NativeSyncPacket = {
    batchID: deps.newBatchId(),
    sourceID: input.sourceId,
    after: record.acknowledged,
    through,
    changes,
  };
  saveSyncRecord(deps.db, input.sessionId, {
    phase: 'pending',
    outbox: freeze(packet, finalMaxSeq),
    messageMap: map,
    maxSeq: finalMaxSeq,
  });
  return commitFrozen({ deps, input, serverId, frozen: { packet, maxSeq: finalMaxSeq }, mayRebatch: true });
}


export { applyPulled } from './sync-import';
export { base64ToBytes } from './sync-protocol';
export { runBackfill } from './sync-backfill';
export type {
  PullOutcome,
  SyncCommitResult,
  SyncDeps,
  SyncPullResult,
  SyncReceipt,
  SyncRegisterResult,
  SyncTransport,
  TurnAdmission,
  UploadChatInput,
  UploadOutcome,
} from './sync-protocol';
