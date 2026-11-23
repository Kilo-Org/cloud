import {
  classifyConflict,
  encodeMessageChanges,
  encodeSessionEntity,
  nextSeq,
  type NativeSyncPacket,
  type PortableSession,
  type PulledSnapshot,
} from '@kilocode/cloud-agent-sdk';
import type { Turn } from '@kilocode/harness-sdk';

import type { ChatDatabase } from '../store';
import { importedTurnId, msgIdForTurn } from './sync-ids';
import {
  imagePartsOf,
  pulledToTurns,
  turnsToPortable,
  type PortableModelRef,
  type SequencedTurn,
  type UploadedBlob,
} from './sync-mapping';
import {
  saveSyncRecord,
  stampServerSessionId,
  syncRecordOf,
  type SyncMessageMap,
  type SyncRecord,
} from './sync-store';

/**
 * The sync engine: upload after a settled exchange, pull before a turn,
 * resolve a CAS conflict by fast-forward or divergence (H4/H5). Every
 * outcome is one discriminated union; the persisted record carries the
 * phase between calls. Transport and harness writes are injected, so the
 * whole state machine runs against fakes in tests.
 */

/** What a register answers: joined, tombstoned, or one of the two failures. */
export type SyncRegisterResult =
  | { readonly type: 'registered'; readonly position: number }
  | { readonly type: 'deleted' }
  | { readonly type: 'retryable' }
  | { readonly type: 'failed'; readonly code: string };

/** The receipt a commit answers with, reduced to what the record keeps. */
export type SyncReceipt = {
  readonly through: number;
  readonly batchID: string;
  readonly digest: string;
};

/** What a commit answers: the new position, a lost CAS, a tombstone, or a failure. */
export type SyncCommitResult =
  | { readonly type: 'committed'; readonly receipt: SyncReceipt }
  | { readonly type: 'superseded'; readonly position: number }
  | { readonly type: 'conflict'; readonly position: number }
  | { readonly type: 'deleted' }
  | { readonly type: 'retryable' }
  | { readonly type: 'failed'; readonly code: string };

/** What a pull answers: the log and its position, a tombstone, or a failure. */
export type SyncPullResult =
  | { readonly type: 'pulled'; readonly snapshot: PulledSnapshot }
  | { readonly type: 'deleted' }
  | { readonly type: 'not_found' }
  | { readonly type: 'retryable' }
  | { readonly type: 'failed'; readonly code: string };

export type SyncTransport = {
  readonly register: (sessionID: string, sourceID: string) => Promise<SyncRegisterResult>;
  readonly putBlob: (sessionID: string, bytes: Uint8Array, mime: string) => Promise<UploadedBlob>;
  readonly commit: (sessionID: string, packet: NativeSyncPacket) => Promise<SyncCommitResult>;
  readonly pull: (sessionID: string) => Promise<SyncPullResult>;
};

export type SyncDeps = {
  readonly db: ChatDatabase;
  readonly transport: SyncTransport;
  /** Writes imported turns into the harness store of `sessionId` (created on first import). */
  readonly importTurns: (input: {
    readonly sessionId: string;
    readonly serverSessionId: string;
    readonly turns: readonly Turn[];
    readonly title: string | null;
    readonly model: string;
  }) => Promise<void>;
  /** Removes the local chat entirely (tombstone seen, or delete everywhere). */
  readonly forgetLocal: (sessionId: string) => Promise<void>;
  readonly newBatchId: () => string;
  readonly newServerSessionId: () => string;
  readonly now: () => number;
};

export type UploadOutcome =
  | { readonly kind: 'synced'; readonly position: number }
  | { readonly kind: 'nothing-to-upload' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'diverged' }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'unknown-chat' };

export type PullOutcome =
  | { readonly kind: 'current' }
  | { readonly kind: 'imported'; readonly count: number }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'unknown-chat' };

/** What the turn-admission check (H6) decides from a fresh pull. */
export type TurnAdmission =
  | { readonly kind: 'local-turn' }
  | { readonly kind: 'live-elsewhere' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'diverged' }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'unavailable' };

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes the base64 an image part stores, without a platform global. */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes: number[] = [];
  for (let index = 0; index + 3 < clean.length; index += 4) {
    const a = BASE64.indexOf(clean[index] ?? '');
    const b = BASE64.indexOf(clean[index + 1] ?? '');
    const c = clean[index + 2] === '=' ? -1 : BASE64.indexOf(clean[index + 2] ?? '');
    const d = clean[index + 3] === '=' ? -1 : BASE64.indexOf(clean[index + 3] ?? '');
    if (a === -1 || b === -1) {
      break;
    }
    bytes.push((a << 2) | (b >> 4));
    if (c !== -1) {
      bytes.push(((b & 0x0f) << 4) | (c >> 2));
    }
    if (d !== -1) {
      bytes.push(((c & 0x03) << 6) | d);
    }
  }
  return Uint8Array.from(bytes);
}

type FrozenPacket = { readonly packet: NativeSyncPacket; readonly maxSeq: number };

function freeze(packet: NativeSyncPacket, maxSeq: number): string {
  return JSON.stringify({ packet, maxSeq } satisfies FrozenPacket);
}

function thaw(raw: string): FrozenPacket | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FrozenPacket>;
    return parsed.packet !== undefined && typeof parsed.maxSeq === 'number'
      ? { packet: parsed.packet, maxSeq: parsed.maxSeq }
      : null;
  } catch {
    return null;
  }
}

function sessionOf(
  record: SyncRecord,
  serverId: string,
  title: string | null,
  model: PortableModelRef,
  created: number,
  now: number
): PortableSession {
  return {
    id: serverId,
    ...(title === null || title === '' ? {} : { title }),
    model,
    time: { created, updated: now },
  };
}

/** Assigns seqs to the turns the map has never seen, above everything known (H2). */
function sequenceNewTurns(
  record: SyncRecord,
  turns: readonly Turn[]
): { readonly sequenced: SequencedTurn[]; readonly map: SyncMessageMap; readonly maxSeq: number } {
  const map: Record<string, { msgId: string; seq: number }> = { ...record.messageMap };
  const sequenced: SequencedTurn[] = [];
  let maxSeq = record.maxSeq;
  for (const turn of turns) {
    const held = map[turn.id];
    if (held !== undefined) {
      if (held.seq > record.ackedSeq) {
        sequenced.push({ turn, seq: held.seq, msgId: held.msgId });
      }
      continue;
    }
    // A turn of nothing but tool results folds into its assistant message;
    // it still takes a map entry so it is never re-examined, but no seq.
    const resultsOnly =
      turn.role === 'user' &&
      turn.parts.length > 0 &&
      turn.parts.every(part => part.kind === 'toolResult');
    if (resultsOnly) {
      map[turn.id] = { msgId: msgIdForTurn(turn.id), seq: 0 };
      continue;
    }
    const seq = nextSeq(maxSeq, maxSeq);
    maxSeq = seq;
    const msgId = msgIdForTurn(turn.id);
    map[turn.id] = { msgId, seq };
    sequenced.push({ turn, seq, msgId });
  }
  return { sequenced, map, maxSeq };
}

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
    stampServerSessionId(deps.db, sessionId, deps.newServerSessionId(), sourceId);
  if (record.serverSessionId !== null && record.phase !== 'local') {
    return { kind: 'ready', record, serverId };
  }
  const registered = await deps.transport.register(serverId, sourceId);
  switch (registered.type) {
    case 'registered':
      saveSyncRecord(deps.db, sessionId, {
        sourceId,
        phase: record.outbox === null ? 'synced' : 'pending',
        acknowledged: Math.max(record.acknowledged, registered.position),
      });
      return { kind: 'ready', record: syncRecordOf(deps.db, sessionId) ?? record, serverId };
    case 'deleted':
      saveSyncRecord(deps.db, sessionId, { phase: 'deleted', outbox: null });
      return { kind: 'deleted' };
    case 'retryable':
      return { kind: 'pending' };
    case 'failed':
      return { kind: 'failed', code: registered.code };
  }
}

/** Applies a pulled snapshot locally: imports new messages and re-seeds the acknowledgement. */
export async function applyPulled(
  deps: SyncDeps,
  sessionId: string,
  serverId: string,
  snapshot: PulledSnapshot,
  model: string
): Promise<number> {
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
  const map: Record<string, { msgId: string; seq: number }> = { ...record.messageMap };
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

/** Everything one upload needs: the chat's turns and the record fields it writes. */
export type UploadChatInput = {
  readonly sessionId: string;
  readonly sourceId: string;
  readonly turns: readonly Turn[];
  readonly title: string | null;
  readonly model: PortableModelRef;
  readonly modelId: string;
  readonly agent: string;
  readonly createdAt: number;
  /** A rename with no new turns still writes the shared session entity (H3). */
  readonly metadataOnly?: boolean;
};

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
      : ready.kind === 'pending'
        ? { kind: 'pending' }
        : { kind: 'failed', code: ready.code };
  }
  const { serverId } = ready;
  let record = ready.record;
  // A frozen outbox that commits is the outcome, even when it carried the
  // chat's only pending messages: there is nothing left to send afterwards.
  let resentPosition: number | null = null;
  if (record.phase === 'diverged') {
    return { kind: 'diverged' };
  }

  // A frozen outbox goes first, byte-identical: the server may already hold
  // it, and resending is how the acknowledgement is recovered.
  if (record.outbox !== null) {
    const frozen = thaw(record.outbox);
    if (frozen !== null) {
      const outcome = await commitFrozen(deps, input, serverId, frozen, false);
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
  const lastAssistant = sequenced[sequenced.length - 1]?.turn.role === 'assistant';
  const idleSeq = lastAssistant ? nextSeq(maxSeq, maxSeq) : null;
  const finalMaxSeq = idleSeq ?? maxSeq;

  const blobs = new Map<string, UploadedBlob>();
  for (const image of imagePartsOf(sequenced.map(one => one.turn))) {
    blobs.set(image.partId, await deps.transport.putBlob(serverId, base64ToBytes(image.base64), image.media));
  }
  const session = sessionOf(record, serverId, input.title, input.model, input.createdAt, now);
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
  return commitFrozen(deps, input, serverId, { packet, maxSeq: finalMaxSeq }, true);
}

async function commitFrozen(
  deps: SyncDeps,
  input: UploadChatInput,
  serverId: string,
  frozen: FrozenPacket,
  mayRebatch: boolean
): Promise<UploadOutcome> {
  const result = await deps.transport.commit(serverId, frozen.packet);
  switch (result.type) {
    case 'committed':
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
    case 'deleted':
      saveSyncRecord(deps.db, input.sessionId, { phase: 'deleted', outbox: null });
      await deps.forgetLocal(input.sessionId);
      return { kind: 'deleted' };
    case 'retryable':
      saveSyncRecord(deps.db, input.sessionId, { phase: 'pending' });
      return { kind: 'pending' };
    case 'failed':
      saveSyncRecord(deps.db, input.sessionId, { phase: 'pending' });
      return { kind: 'failed', code: result.code };
    case 'superseded':
    case 'conflict':
      return resolveConflict(deps, input, serverId, frozen, mayRebatch);
  }
}

/** H5: pull, import, then fast-forward above the pulled max seq or park diverged. */
async function resolveConflict(
  deps: SyncDeps,
  input: UploadChatInput,
  serverId: string,
  frozen: FrozenPacket,
  mayRebatch: boolean
): Promise<UploadOutcome> {
  const pulled = await deps.transport.pull(serverId);
  switch (pulled.type) {
    case 'deleted':
      saveSyncRecord(deps.db, input.sessionId, { phase: 'deleted', outbox: null });
      await deps.forgetLocal(input.sessionId);
      return { kind: 'deleted' };
    case 'not_found':
    case 'retryable':
      return { kind: 'pending' };
    case 'failed':
      return { kind: 'failed', code: pulled.code };
    case 'pulled':
      break;
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
  await applyPulled(deps, input.sessionId, serverId, snapshot, input.modelId);
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
  return commitFrozen(deps, input, serverId, { packet: rebatched, maxSeq: frozen.maxSeq }, false);
}

