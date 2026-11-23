import { type Turn } from '@kilocode/harness-sdk';

import {
  applyPulled,
  ensureRegistered,
  type PullOutcome,
  type SyncDeps,
  type TurnAdmission,
} from './sync-engine';
import { tailStateOf } from './sync-mapping';
import { unreadyOutcome } from './sync-protocol';
import { saveSyncRecord, syncRecordOf } from './sync-store';

/**
 * Pulling: opening a synced chat, admitting a turn (H6), and the
 * discard-and-reload that resolves a divergence (H5). Split from the
 * upload engine so each half of the state machine stays readable alone.
 */

/** Pulls one synced chat and imports whatever arrived since the acknowledgement. */
export async function pullChat(
  deps: SyncDeps,
  input: { readonly sessionId: string; readonly sourceId: string; readonly modelId: string }
): Promise<PullOutcome> {
  const ready = await ensureRegistered(deps, input.sessionId, input.sourceId);
  if (ready.kind !== 'ready') {
    if (ready.kind === 'deleted') {
      await deps.forgetLocal(input.sessionId);
      return { kind: 'deleted' };
    }
    return unreadyOutcome(ready);
  }
  const pulled = await deps.transport.pull(ready.serverId);
  if (pulled.type === 'deleted') {
    saveSyncRecord(deps.db, input.sessionId, { phase: 'deleted', outbox: null });
    await deps.forgetLocal(input.sessionId);
    return { kind: 'deleted' };
  }
  if (pulled.type === 'not_found') {
    return { kind: 'not-found' };
  }
  if (pulled.type === 'retryable') {
    return { kind: 'pending' };
  }
  if (pulled.type === 'failed') {
    return { kind: 'failed', code: pulled.code };
  }
  // Registering adopts the server's position as this device's acknowledgement,
  // so position alone can never prove the turns are local: a first import of
  // another device's session sits at the same position with nothing in the
  // store. Applying the snapshot is what knows; it imports only the messages
  // the map has never seen.
  const count = await applyPulled({
    deps,
    sessionId: input.sessionId,
    serverId: ready.serverId,
    snapshot: pulled.snapshot,
    model: input.modelId,
  });
  return count === 0 ? { kind: 'current' } : { kind: 'imported', count };
}

/** H6 admission for a synced chat, from one fresh pull. Unsynced chats always run locally. */
export async function admitTurn(
  deps: SyncDeps,
  input: {
    readonly sessionId: string;
    readonly sourceId: string;
    readonly modelId: string;
    readonly liveElsewhere: boolean;
  }
): Promise<TurnAdmission> {
  const record = syncRecordOf(deps.db, input.sessionId);
  if (record === null) {
    return { kind: 'local-turn' };
  }
  if (record.serverSessionId === null || record.phase === 'local') {
    return { kind: 'local-turn' };
  }
  if (record.phase === 'diverged') {
    return { kind: 'diverged' };
  }
  if (record.phase === 'deleted') {
    return { kind: 'deleted' };
  }
  const outcome = await pullChat(deps, input);
  if (outcome.kind === 'deleted') {
    return { kind: 'deleted' };
  }
  if (outcome.kind === 'pending' || outcome.kind === 'failed' || outcome.kind === 'unknown-chat') {
    return { kind: 'unavailable' };
  }
  if (input.liveElsewhere) {
    return { kind: 'live-elsewhere' };
  }
  const pulled = await deps.transport.pull(record.serverSessionId);
  if (pulled.type !== 'pulled') {
    return pulled.type === 'deleted' ? { kind: 'deleted' } : { kind: 'unavailable' };
  }
  return tailStateOf(pulled.snapshot.messages, deps.now()).kind === 'busy'
    ? { kind: 'busy' }
    : { kind: 'local-turn' };
}

/**
 * Discards the divergent local tail: drops unacknowledged map entries and
 * the outbox, then pulls the server log over the chat. Answers the user
 * text of the discarded turns so the screen can restore it to the composer.
 */
export async function discardDiverged(
  deps: SyncDeps,
  input: {
    readonly sessionId: string;
    readonly sourceId: string;
    readonly modelId: string;
    readonly turns: readonly Turn[];
  }
): Promise<{ readonly kind: 'discarded'; readonly restoredText: string } | PullOutcome> {
  const record = syncRecordOf(deps.db, input.sessionId);
  if (record === null) {
    return { kind: 'unknown-chat' };
  }
  const discardedIds = new Set(
    Object.entries(record.messageMap)
      .filter(([, entry]) => entry.seq > record.ackedSeq)
      .map(([turnId]) => turnId)
  );
  const restoredText = input.turns
    .filter(turn => discardedIds.has(turn.id) && turn.role === 'user')
    .flatMap(turn => turn.parts.filter(part => part.kind === 'text').map(part => part.body))
    .join('\n');
  const map: Record<string, { msgId: string; seq: number }> = {};
  for (const [turnId, entry] of Object.entries(record.messageMap)) {
    if (!discardedIds.has(turnId)) {
      map[turnId] = entry;
    }
  }
  saveSyncRecord(deps.db, input.sessionId, {
    phase: 'pending',
    outbox: null,
    messageMap: map,
    maxSeq: record.ackedSeq,
  });
  const outcome = await pullChat(deps, input);
  if (outcome.kind === 'current' || outcome.kind === 'imported') {
    saveSyncRecord(deps.db, input.sessionId, { phase: 'synced' });
    return { kind: 'discarded', restoredText };
  }
  return outcome;
}
