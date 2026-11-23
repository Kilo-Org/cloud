import { z } from 'zod';
import {
  classifyNativeSyncError,
  nativeClientKindSchema,
  NativeSyncError,
  type NativeClientKind,
  type NativeSyncClient,
} from './native-sync';
import type { NativeSnapshotMessage, NativeSnapshotSession } from './native-sync-snapshot';

export type NativeEntityKind =
  | 'session'
  | 'message'
  | 'message-part'
  | 'inbox'
  | 'instruction-entry'
  | 'instruction-state'
  | 'instruction-blob'
  | 'asset';

export type NativeSyncChange =
  | { op: 'put'; kind: NativeEntityKind; id: string; value: unknown }
  | { op: 'put'; kind: NativeEntityKind; id: string; blob: { hash: string; bytes: number } }
  | { op: 'remove'; kind: NativeEntityKind; id: string; cause: string };

/** One frozen batch. Retries must resubmit the same packet so the body bytes repeat verbatim. */
export type NativeSyncPacket = {
  batchID: string;
  sourceID: string;
  after: number;
  through: number;
  changes: NativeSyncChange[];
};

const positionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const nativeSyncReceiptSchema = z.object({
  version: z.literal(1),
  sessionID: z.string(),
  batchID: z.string(),
  after: positionSchema,
  through: positionSchema,
  revision: positionSchema,
  changes: z.number().int().min(0),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  committedAt: z.number().int(),
});
export type NativeSyncReceipt = z.infer<typeof nativeSyncReceiptSchema>;

export type NativeSessionSource = {
  sourceID: string;
  client: NativeClientKind;
  joinedAt: number;
};

const sourceSchema = z.object({
  sourceID: z.string(),
  client: nativeClientKindSchema,
  joinedAt: z.number().int(),
});

export const nativeSessionLiveStateSchema = z.object({
  version: z.literal(1),
  sessionID: z.string(),
  tenant: z.object({ type: z.enum(['user', 'organization']), id: z.string() }),
  deleted: z.literal(false),
  creatorID: z.string(),
  sourceID: z.string(),
  sources: z.array(sourceSchema).optional().default([]),
  position: positionSchema,
  revision: positionSchema,
  batches: z.number().int().min(0),
  lastReceipt: nativeSyncReceiptSchema.nullable(),
  usage: z.object({
    entities: z.number().int().min(0),
    inlineBytes: z.number().int().min(0),
    blobBytes: z.number().int().min(0),
  }),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  status: z
    .object({
      value: z.string(),
      version: positionSchema,
      updatedAt: z.number().int(),
    })
    .passthrough()
    .nullable()
    .optional(),
});
export type NativeSessionLiveState = z.infer<typeof nativeSessionLiveStateSchema>;

const deletedStateSchema = z.object({
  version: z.literal(1),
  sessionID: z.string(),
  deleted: z.literal(true),
});

const blobAckSchema = z.object({
  version: z.literal(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  created: z.boolean(),
});

export type PortableModel = { providerID: string; id: string; variant?: string };

export type PortableContent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      state: {
        status: 'completed' | 'error';
        input: Record<string, unknown> | string;
        content: { type: 'text'; text: string }[];
      };
    };

export type PortableMessage =
  | {
      type: 'user';
      id: string;
      seq: number;
      text: string;
      files: { mime: string; name?: string; blob: { hash: string; bytes: number } }[];
      time: { created: number };
    }
  | {
      type: 'assistant';
      id: string;
      seq: number;
      agent: string;
      model: PortableModel;
      content: PortableContent[];
      finish?: string;
      time: { created: number; completed: number };
    }
  | {
      type: 'idle';
      id: string;
      seq: number;
      outcome: 'succeeded' | 'failed' | 'interrupted';
      time: { created: number };
    };

export type PortableSession = {
  id: string;
  title?: string;
  model?: PortableModel;
  time: { created: number; updated: number; idle?: number };
};

export type PulledMessage = NativeSnapshotMessage & { sourceID: string | null };

export type PulledSnapshot = {
  position: number;
  revision: number;
  lastReceipt: NativeSyncReceipt | null;
  sources: NativeSessionSource[];
  session: NativeSnapshotSession | null;
  messages: PulledMessage[];
  maxSeq: number;
};

export type NativeRegisterResult =
  | { type: 'registered'; state: NativeSessionLiveState }
  | { type: 'deleted' }
  | { type: 'retryable'; retryAfterMs?: number }
  | { type: 'failed'; code: string };

export type NativeCommitResult =
  | { type: 'committed'; receipt: NativeSyncReceipt }
  | { type: 'superseded'; position: number }
  | { type: 'conflict'; position: number }
  | { type: 'deleted' }
  | { type: 'retryable'; retryAfterMs?: number }
  | { type: 'failed'; code: string };

export type NativePullResult =
  | { type: 'pulled'; snapshot: PulledSnapshot }
  | { type: 'deleted' }
  | { type: 'not_found' }
  | { type: 'retryable' }
  | { type: 'failed'; code: string };

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Synchronous SHA-256 hex: content addressing cannot wait on a platform crypto API. */
export function sha256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const bitLength = bytes.byteLength * 8;
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
  for (let block = 0; block < paddedLength; block += 64) {
    for (let index = 0; index < 16; index++) w[index] = view.getUint32(block + index * 4);
    for (let index = 16; index < 64; index++) {
      const s0 = rotr(w[index - 15]!, 7) ^ rotr(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3);
      const s1 = rotr(w[index - 2]!, 17) ^ rotr(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state as unknown as number[];
    for (let index = 0; index < 64; index++) {
      const s1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + s1 + ch + SHA256_K[index]! + w[index]!) >>> 0;
      const s0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return [...state].map(word => word.toString(16).padStart(8, '0')).join('');
}

const MAX_CHANGES = 64;
const MAX_PACKET_BYTES = 512 * 1024;
const MAX_INLINE_BYTES = 64 * 1024;

export type PacketAdmissionViolation = 'too_many_changes' | 'packet_too_large' | 'inline_too_large';

/** The service's batch admission limits, checked before a packet leaves the device. */
export function packetAdmissionViolation(
  changes: readonly NativeSyncChange[]
): PacketAdmissionViolation | null {
  if (changes.length > MAX_CHANGES) return 'too_many_changes';
  const encoder = new TextEncoder();
  let total = 0;
  for (const change of changes) {
    if (change.op !== 'put' || !('value' in change)) continue;
    const bytes = encoder.encode(JSON.stringify(change.value)).byteLength;
    if (bytes > MAX_INLINE_BYTES) return 'inline_too_large';
    total += bytes;
    if (total > MAX_PACKET_BYTES) return 'packet_too_large';
  }
  return null;
}

/** The shared session record as mobile writes it: no agent, no local directory. */
export function encodeSessionEntity(session: PortableSession): NativeSyncChange {
  return {
    op: 'put',
    kind: 'session',
    id: session.id,
    value: {
      id: session.id,
      ...(session.title === undefined ? {} : { title: session.title }),
      ...(session.model === undefined
        ? {}
        : {
            model: {
              id: session.model.id,
              providerID: session.model.providerID,
              ...(session.model.variant === undefined ? {} : { variant: session.model.variant }),
            },
          }),
      time: {
        created: session.time.created,
        updated: session.time.updated,
        ...(session.time.idle === undefined ? {} : { idle: session.time.idle }),
      },
      origin: { directory: '', client: 'mobile' },
    },
  };
}

function encodeContent(content: PortableContent): Record<string, unknown> {
  if (content.type === 'tool') {
    return {
      type: 'tool',
      id: content.id,
      name: content.name,
      state: {
        status: content.state.status,
        input: content.state.input,
        content: content.state.content.map(item => ({ type: 'text', text: item.text })),
      },
    };
  }
  return { type: content.type, text: content.text };
}

/**
 * Portable messages as wire changes in the CLI producer's shapes. `through` is the
 * committing packet's `through`: it stamps the split-assistant frontier and each part's
 * position, so the snapshot reader accepts the parts once the packet commits.
 */
export function encodeMessageChanges(
  messages: readonly PortableMessage[],
  through: number
): NativeSyncChange[] {
  const changes: NativeSyncChange[] = [];
  for (const message of messages) {
    if (message.type === 'user') {
      const files = message.files.map(file => ({
        mime: file.mime,
        ...(file.name === undefined ? {} : { name: file.name }),
        uri: `media:${file.blob.hash}`,
        source: { type: 'inline' },
      }));
      changes.push({
        op: 'put',
        kind: 'message',
        id: message.id,
        value: {
          seq: message.seq,
          message: {
            id: message.id,
            type: 'user',
            text: message.text,
            files,
            time: { created: message.time.created },
          },
        },
      });
      message.files.forEach((file, index) => {
        const pointer = `/message/files/${index}`;
        changes.push({
          op: 'put',
          kind: 'asset',
          id: sha256Hex(`message:${message.id}:${pointer}`),
          value: {
            entity: { kind: 'message', id: message.id },
            pointer,
            reference: `media:${file.blob.hash}`,
            blob: { hash: file.blob.hash, bytes: file.blob.bytes },
            mime: file.mime,
            ...(file.name === undefined ? {} : { name: file.name }),
          },
        });
      });
      continue;
    }
    if (message.type === 'assistant') {
      changes.push({
        op: 'put',
        kind: 'message',
        id: message.id,
        value: {
          seq: message.seq,
          message: {
            id: message.id,
            type: 'assistant',
            agent: message.agent,
            model: {
              id: message.model.id,
              providerID: message.model.providerID,
              ...(message.model.variant === undefined ? {} : { variant: message.model.variant }),
            },
            ...(message.finish === undefined ? {} : { finish: message.finish }),
            time: { created: message.time.created, completed: message.time.completed },
          },
          parts: { count: message.content.length, through },
        },
      });
      message.content.forEach((content, ordinal) => {
        changes.push({
          op: 'put',
          kind: 'message-part',
          id: `${message.id}/${ordinal}`,
          value: {
            messageID: message.id,
            ordinal,
            position: through,
            part: encodeContent(content),
          },
        });
      });
      continue;
    }
    changes.push({
      op: 'put',
      kind: 'message',
      id: message.id,
      value: {
        seq: message.seq,
        message: {
          id: message.id,
          type: 'idle',
          outcome: message.outcome,
          time: { created: message.time.created },
        },
      },
    });
  }
  return changes;
}

/** The next sequence a writer may assign: above everything pulled and everything local. */
export function nextSeq(snapshotMaxSeq: number, localMaxSeq: number): number {
  return Math.max(snapshotMaxSeq, localMaxSeq) + 1;
}

/**
 * Conflict classification (H5): unacknowledged local messages all sit above the pulled
 * log, so the packet rebatches onto the new position; any overlap means the histories
 * diverged and the local tail parks until the user discards it.
 */
export function classifyConflict(
  localUnacked: readonly { seq: number }[],
  pulledMaxSeq: number
): 'fast-forward' | 'diverged' {
  return localUnacked.every(message => message.seq > pulledMaxSeq) ? 'fast-forward' : 'diverged';
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof NativeSyncError) return error.code;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

/** Write side of session sync, on the same grant exchange as the read/live client. */
export class NativeSyncWriter {
  constructor(
    private readonly client: NativeSyncClient,
    private readonly organizationID?: string
  ) {}

  async register(
    sessionID: string,
    sourceID: string,
    client: NativeClientKind
  ): Promise<NativeRegisterResult> {
    try {
      const state = nativeSessionLiveStateSchema.parse(
        await this.client.request(
          `/v1/sessions/${encodeURIComponent(sessionID)}`,
          {
            method: 'PUT',
            body: JSON.stringify({ version: 1, sourceID, client }),
          },
          this.organizationID
        )
      );
      return { type: 'registered', state };
    } catch (error) {
      if (errorCode(error) === 'session_deleted') return { type: 'deleted' };
      return classifyNativeSyncError(error);
    }
  }

  async putBlob(
    sessionID: string,
    bytes: Uint8Array,
    mime: string
  ): Promise<{ hash: string; bytes: number }> {
    const hash = sha256Hex(bytes);
    const ack = blobAckSchema.parse(
      await this.client.request(
        `/v1/sessions/${encodeURIComponent(sessionID)}/blobs/${hash}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': mime === '' ? 'application/octet-stream' : mime,
            'Content-Length': String(bytes.byteLength),
          },
          body: bytes as BodyInit,
        },
        this.organizationID
      )
    );
    if (ack.hash !== hash || ack.bytes !== bytes.byteLength) {
      throw new NativeSyncError('blob_hash_mismatch');
    }
    return { hash: ack.hash, bytes: ack.bytes };
  }

  async commit(sessionID: string, packet: NativeSyncPacket): Promise<NativeCommitResult> {
    const violation = packetAdmissionViolation(packet.changes);
    if (violation !== null) return { type: 'failed', code: violation };
    try {
      const receipt = nativeSyncReceiptSchema.parse(
        await this.client.request(
          `/v1/sessions/${encodeURIComponent(sessionID)}/batches`,
          {
            method: 'POST',
            body: JSON.stringify({
              version: 1,
              sourceID: packet.sourceID,
              batchID: packet.batchID,
              after: packet.after,
              through: packet.through,
              changes: packet.changes,
            }),
          },
          this.organizationID
        )
      );
      return { type: 'committed', receipt };
    } catch (error) {
      if (error instanceof NativeSyncError) {
        if (error.code === 'session_deleted') return { type: 'deleted' };
        if (error.code === 'batch_superseded' && error.position !== undefined) {
          return { type: 'superseded', position: error.position };
        }
        if (error.code === 'position_conflict' && error.position !== undefined) {
          return { type: 'conflict', position: error.position };
        }
      }
      return classifyNativeSyncError(error);
    }
  }

  async pull(sessionID: string): Promise<NativePullResult> {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await this.client.getSnapshot(sessionID, this.organizationID);
        const rawState: unknown = await this.client.request(
          `/v1/sessions/${encodeURIComponent(sessionID)}`,
          undefined,
          this.organizationID
        );
        if (deletedStateSchema.safeParse(rawState).success) return { type: 'deleted' };
        const state = nativeSessionLiveStateSchema.parse(rawState);
        if (state.revision !== snapshot.revision || state.position !== snapshot.position) continue;
        const sourceByMessage = new Map<string, string | null>();
        for (const entity of snapshot.entities) {
          if (entity.kind === 'message') sourceByMessage.set(entity.id, entity.sourceID ?? null);
        }
        const messages: PulledMessage[] = snapshot.messages.map(message => ({
          ...message,
          sourceID: sourceByMessage.get(message.message.id) ?? null,
        }));
        return {
          type: 'pulled',
          snapshot: {
            position: snapshot.position,
            revision: snapshot.revision,
            lastReceipt: state.lastReceipt,
            sources: state.sources,
            session: snapshot.session ?? null,
            messages,
            maxSeq: messages.reduce((max, message) => Math.max(max, message.seq), 0),
          },
        };
      }
      return { type: 'retryable' };
    } catch (error) {
      const code = errorCode(error);
      if (code === 'session_deleted') return { type: 'deleted' };
      if (code === 'session_not_found' || code === 'not_found') return { type: 'not_found' };
      if (error instanceof NativeSyncError && error.status === 404) return { type: 'not_found' };
      if (code === 'revision_changed' || code === 'blob_not_found') return { type: 'retryable' };
      if (
        error instanceof Error &&
        !(error instanceof z.ZodError) &&
        /timed out|canceled/.test(error.message) &&
        !(error instanceof NativeSyncError)
      ) {
        return { type: 'retryable' };
      }
      const classified = classifyNativeSyncError(error);
      return classified.type === 'retryable' ? { type: 'retryable' } : classified;
    }
  }
}
