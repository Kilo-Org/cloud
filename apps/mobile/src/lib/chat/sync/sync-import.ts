import type { PulledSnapshot } from '@kilocode/cloud-agent-sdk';

import { pulledToTurns } from './sync-mapping';
import { saveSyncRecord, syncRecordOf } from './sync-store';
import { importedTurnId } from './sync-ids';
import type { SyncDeps } from './sync-protocol';
import type { MutableMessageMap } from './sync-store';

/**
 * Importing a pulled log: the messages this device has not seen become
 * harness turns, and the acknowledgement moves to the pulled position.
 */

/** Applies a pulled snapshot locally: imports new messages and re-seeds the acknowledgement. */
export async function applyPulled(input: {
  readonly deps: SyncDeps;
  readonly sessionId: string;
  readonly serverId: string;
  readonly snapshot: PulledSnapshot;
  readonly model: string;
}): Promise<number> {
  const { deps, sessionId, serverId, snapshot, model } = input;
  const record = syncRecordOf(deps.db, sessionId);
  if (record === null) {
    return 0;
  }
  const known = new Set(Object.values(record.messageMap).map(entry => entry.msgId));
  const fresh = snapshot.messages.filter(one => !known.has(one.message.id));
  const turns = pulledToTurns(fresh, sessionId);
  if (turns.length > 0) {
    await deps.importTurns({
      sessionId,
      serverSessionId: serverId,
      turns,
      title: snapshot.session?.title ?? null,
      model,
    });
  }
  const map: MutableMessageMap = { ...record.messageMap };
  for (const one of fresh) {
    map[importedTurnId(one.message.time.created, one.seq)] = {
      msgId: one.message.id,
      seq: one.seq,
    };
  }
  saveSyncRecord(deps.db, sessionId, {
    acknowledged: snapshot.position,
    ackBatch: snapshot.lastReceipt?.batchID ?? record.ackBatch,
    ackDigest: snapshot.lastReceipt?.digest ?? record.ackDigest,
    maxSeq: Math.max(record.maxSeq, snapshot.maxSeq),
    // `ackedSeq` counts only what THIS device committed: a pulled log raises
    // the numbering waterline, never this device's acknowledgement, or the
    // local tail a conflict must park would look already sent.
    ackedSeq: record.ackedSeq,
    messageMap: map,
    phase: record.phase === 'diverged' ? 'diverged' : 'synced',
  });
  return turns.length;
}

