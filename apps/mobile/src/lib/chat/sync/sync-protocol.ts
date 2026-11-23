import {
  type NativeSyncPacket,
  nextSeq,
  type PortableSession,
  type PulledSnapshot,
} from '@kilocode/cloud-agent-sdk';
import type { Turn } from '@kilocode/harness-sdk';

import { msgIdForTurn } from './sync-ids';
import { type PortableModelRef, type SequencedTurn } from './sync-mapping';
import { type MutableMessageMap, type SyncMessageMap, type SyncRecord } from './sync-store';

/**
 * The wire contract the engine speaks: what each transport call answers, what
 * a chat keeps between calls, and the encoders that turn turns into messages.
 * It holds no state and performs no I/O.
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

export type { UploadedBlob };

export type SyncTransport = {
  readonly register: (sessionID: string, sourceID: string) => Promise<SyncRegisterResult>;
  readonly putBlob: (sessionID: string, bytes: Uint8Array, mime: string) => Promise<UploadedBlob>;
  readonly commit: (sessionID: string, packet: NativeSyncPacket) => Promise<SyncCommitResult>;
  readonly pull: (sessionID: string) => Promise<SyncPullResult>;
};

import type { ChatDatabase } from '../store';
import { type UploadedBlob } from './sync-mapping';

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

/**
 * Decodes the base64 an image part stores, without a platform global and
 * without bit operations: each 4-character group is three bytes expressed in
 * base 64, so plain arithmetic answers them.
 */
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
    bytes.push(a * 4 + Math.floor(b / 16));
    if (c !== -1) {
      bytes.push((b % 16) * 16 + Math.floor(c / 4));
    }
    if (d !== -1) {
      bytes.push((c % 4) * 64 + d);
    }
  }
  return Uint8Array.from(bytes);
}

export type FrozenPacket = { readonly packet: NativeSyncPacket; readonly maxSeq: number };

export function freeze(packet: NativeSyncPacket, maxSeq: number): string {
  return JSON.stringify({ packet, maxSeq } satisfies FrozenPacket);
}

export function thaw(raw: string): FrozenPacket | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FrozenPacket>;
    return parsed.packet !== undefined && typeof parsed.maxSeq === 'number'
      ? { packet: parsed.packet, maxSeq: parsed.maxSeq }
      : null;
  } catch {
    return null;
  }
}

export function sessionOf(input: {
  readonly serverId: string;
  readonly title: string | null;
  readonly model: PortableModelRef;
  readonly created: number;
  readonly now: number;
}): PortableSession {
  const { serverId, title, model, created, now } = input;
  return {
    id: serverId,
    ...(title === null || title === '' ? {} : { title }),
    model,
    time: { created, updated: now },
  };
}

/** The turns a fresh upload carries, the map they extend, and the new waterline. */
export type SequencedTurns = {
  readonly sequenced: SequencedTurn[];
  readonly map: SyncMessageMap;
  readonly maxSeq: number;
};

/** Assigns seqs to the turns the map has never seen, above everything known (H2). */
export function sequenceNewTurns(record: SyncRecord, turns: readonly Turn[]): SequencedTurns {
  const map: MutableMessageMap = { ...record.messageMap };
  const sequenced: SequencedTurn[] = [];
  let maxSeq = record.maxSeq;
  for (const turn of turns) {
    const held = map[turn.id];
    if (held !== undefined) {
      if (held.seq > record.ackedSeq) {
        sequenced.push({ turn, seq: held.seq, msgId: held.msgId });
      }
    } else {
      // A turn of nothing but tool results folds into its assistant message;
      // it still takes a map entry so it is never re-examined, but no seq.
      const resultsOnly =
        turn.role === 'user' &&
        turn.parts.length > 0 &&
        turn.parts.every(part => part.kind === 'toolResult');
      if (resultsOnly) {
        map[turn.id] = { msgId: msgIdForTurn(turn.id), seq: 0 };
      } else {
        const seq = nextSeq(maxSeq, maxSeq);
        maxSeq = seq;
        const msgId = msgIdForTurn(turn.id);
        map[turn.id] = { msgId, seq };
        sequenced.push({ turn, seq, msgId });
      }
    }
  }
  return { sequenced, map, maxSeq };
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

