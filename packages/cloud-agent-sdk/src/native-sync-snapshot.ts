import { z } from 'zod';
import {
  kilo2MessageSchema,
  kilo2SessionSchema,
  type Kilo2Message,
  type Kilo2Session,
} from '@kilocode/session-ingest-contracts';
import {
  hasUndisplayableKilo2Assets,
  kilo2AssetKey,
  readKilo2FileReferences,
  readKilo2Messages,
  type Kilo2FileReference,
} from './kilo2-source-messages';
import type { SessionSnapshot } from './types';

// The intersection merges validated contract fields with the full JSON tree,
// retaining nested metadata stripped from the display-facing contract schema.
const nativeJsonObjectSchema = z.record(z.string(), z.json());
const nativeMessageSchema = z.intersection(kilo2MessageSchema, nativeJsonObjectSchema);
// Sync deliberately excludes local location/project bindings. Origin is display-only.
const portableSessionSchema = kilo2SessionSchema
  .omit({ location: true })
  .extend({
    origin: z.object({ directory: z.string() }).passthrough(),
  })
  .passthrough();
export const nativeSnapshotSessionSchema = z.intersection(
  portableSessionSchema,
  nativeJsonObjectSchema
);
export type NativeSnapshotSession = z.infer<typeof nativeSnapshotSessionSchema>;

const positionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const idSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(value => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code < 32 || code === 127) return false;
    }
    return true;
  }, 'Entity IDs must not contain control characters');
const blobRefSchema = z.strictObject({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z
    .number()
    .int()
    .min(0)
    .max(8 * 1024 * 1024),
});
const sessionIDSchema = idSchema.min(3).startsWith('ses');
const kindSchema = z.enum([
  'session',
  'message',
  'message-part',
  'inbox',
  'instruction-entry',
  'instruction-state',
  'instruction-blob',
  'asset',
]);
const entityHeader = { kind: kindSchema, id: idSchema, revision: positionSchema };
const entitySchema = z.union([
  z.strictObject({ ...entityHeader, value: z.json() }),
  z.strictObject({
    ...entityHeader,
    blob: blobRefSchema,
  }),
]);
const stateSchema = z.discriminatedUnion('deleted', [
  z.object({
    version: z.literal(1),
    sessionID: sessionIDSchema,
    deleted: z.literal(false),
    position: positionSchema,
    revision: positionSchema,
  }),
  z.object({ version: z.literal(1), sessionID: sessionIDSchema, deleted: z.literal(true) }),
]);
const pageSchema = z.strictObject({
  version: z.literal(1),
  sessionID: sessionIDSchema,
  revision: positionSchema,
  position: positionSchema,
  entities: z.array(entitySchema).max(100),
  next: z.string().min(1).max(4096).nullable(),
});
const messageSchema = z.looseObject({
  seq: positionSchema,
  message: nativeMessageSchema,
});
const partsSchema = z.strictObject({ count: positionSchema, through: positionSchema });
const partSchema = z.strictObject({
  messageID: idSchema,
  ordinal: positionSchema,
  position: positionSchema,
  part: z.record(z.string(), z.json()),
});
const assetMappingSchema = z
  .object({
    entity: z.strictObject({ kind: z.enum(['message', 'message-part']), id: idSchema }),
    pointer: z.string().min(1),
    reference: z.string().min(1),
    blob: blobRefSchema,
    mime: z.string().optional(),
  })
  .passthrough();

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
/** Read at most the authorized blob size, canceling the response on overflow. */
export type NativeAssetReader = (
  path: string,
  advertisedBytes: number,
  init?: RequestInit
) => Promise<ArrayBuffer>;
type ResolvedEntity = { entity: NativeEntity; value: unknown };

/** Portable wire entities; blob references remain available to callers. */
export type NativeEntity = z.infer<typeof entitySchema>;

/** A full native value plus sync-specific ordering and reconstruction integrity. */
export type NativeSnapshotMessage = {
  message: Kilo2Message;
  seq: number;
  /** Source ordinals aligned with reconstructed content, not display part IDs. */
  partOrdinals?: number[];
  incomplete?: boolean;
};

export type NativeSnapshot = {
  position: number;
  revision: number;
  /** Absent when no native session entity has been uploaded yet. */
  session?: NativeSnapshotSession;
  messages: NativeSnapshotMessage[];
  entities: NativeEntity[];
  /** Resolved authorized bytes, keyed by kilo2AssetKey(display ID, native URI, MIME). */
  assetURLs?: Record<string, string>;
};

export type NativeSnapshotProjection = {
  session: Kilo2Session;
  position: number;
  revision: number;
  messages: SessionSnapshot['messages'];
  /** Never treat an omitted, unreconstructed message as a complete empty answer. */
  incompleteMessageIDs: string[];
};

/** Project only complete canonical values; live replay/recovery remains transport-owned. */
export function projectNativeSnapshot(snapshot: NativeSnapshot): NativeSnapshotProjection {
  if (!snapshot.session) {
    throw Object.assign(new Error('The native snapshot has no session metadata'), {
      code: 'session_metadata_missing',
    });
  }
  const session: Kilo2Session = {
    ...snapshot.session,
    // This path labels the transcript. It is not a runtime root or filesystem grant.
    location: { directory: snapshot.session.origin.directory },
  };
  const messages: Kilo2Message[] = [];
  const incompleteMessageIDs: string[] = [];
  for (const item of snapshot.messages) {
    if (item.incomplete) incompleteMessageIDs.push(item.message.id);
    // A message with no possible display is dropped, not reported as missing data.
    else if (!hasUndisplayableKilo2Assets(item.message, snapshot.assetURLs)) {
      messages.push(item.message);
    }
  }
  return {
    session,
    position: snapshot.position,
    revision: snapshot.revision,
    messages: readKilo2Messages(session, messages, { assetURLs: snapshot.assetURLs }),
    incompleteMessageIDs,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Maximum simultaneous snapshot JSON blob reads. */
const SNAPSHOT_READ_CONCURRENCY = 4;
// Binary attachment reads pin up to the per-blob byte cap each, on top of the
// retained base64 strings, so they run with a tighter window.
const SNAPSHOT_ASSET_READ_CONCURRENCY = 2;

/** Hand the buffer's base64 form to `sink` without holding full copies alive. */
function viewBytesAsBase64(buffer: ArrayBuffer, sink: (base64: string) => void): void {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)));
  }
  sink(btoa(chunks.join('')));
}

/**
 * Resolve independent reads with bounded parallelism. Task index `i` starts
 * before `i+1`, with at most `limit` in flight; queued tasks stay unsent after
 * any task fails. The first started failing task's error settles the runner,
 * after in-flight reads finish, with no unhandled rejections.
 */
async function readWithBoundedConcurrency<T>(
  limit: number,
  tasks: (() => Promise<T>)[]
): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  const workers: Promise<void>[] = [];
  let next = 0;
  let failedIndex = -1;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const task = tasks[next];
      if (task === undefined) return;
      const index = next++;
      try {
        results[index] = await task();
      } catch (error) {
        // Keep the earliest started failure regardless of settlement order.
        if (failedIndex === -1 || index < failedIndex) {
          failedIndex = index;
          failure = error;
        }
        return;
      }
    }
  };
  for (let index = 0; index < Math.min(limit, tasks.length); index++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
  return results;
}

function snapshotChanged(): Error & { code: string } {
  return Object.assign(new Error('The native session changed while reading its snapshot'), {
    code: 'revision_changed',
  });
}

async function resolveSnapshotAssets(
  snapshot: NativeSnapshot,
  resolved: ResolvedEntity[],
  path: string,
  readAsset?: NativeAssetReader,
  resolvedBlobs: Map<string, { bytes: number; base64: string }> = new Map()
): Promise<Record<string, string>> {
  const mappings = new Map<string, z.infer<typeof assetMappingSchema>>();
  for (const item of resolved) {
    if (item.entity.kind !== 'asset') continue;
    const parsed = assetMappingSchema.safeParse(item.value);
    if (!parsed.success) continue;
    const mapping = parsed.data;
    const key = `${mapping.entity.kind}/${mapping.entity.id}${mapping.pointer}`;
    if (mappings.has(key)) throw new Error('Native snapshot has ambiguous asset mappings');
    mappings.set(key, mapping);
  }
  const wants: { file: Kilo2FileReference; hash: string; bytes: number }[] = [];
  const assetURLs: Record<string, string> = {};
  const missing: { hash: string; bytes: number }[] = [];
  const queuedHashes = new Set<string>();
  const claimedBytes = new Map<string, number>();
  for (const item of snapshot.messages) {
    if (item.incomplete) continue;
    for (const file of readKilo2FileReferences(item.message)) {
      // Inline bytes need no mapping; an absolute remote reference can never be bound to a stored
      // asset.
      if (file.uri.startsWith('data:') || /^https?:\/\//.test(file.uri)) continue;
      const split =
        file.contentIndex === undefined ? undefined : item.partOrdinals?.[file.contentIndex];
      const owner =
        split === undefined
          ? `message/${item.message.id}`
          : `message-part/${item.message.id}/${split}`;
      const pointer =
        file.contentIndex === undefined
          ? `/message/files/${file.fileIndex}`
          : `${split === undefined ? `/message/content/${file.contentIndex}` : '/part'}/state/content/${file.fileIndex}`;
      const mapping = mappings.get(`${owner}${pointer}`);
      if (
        !mapping ||
        mapping.reference !== file.uri ||
        mapping.mime !== file.mime ||
        (file.uri.startsWith('media:') && file.uri !== `media:${mapping.blob.hash}`)
      ) {
        throw Object.assign(
          new Error(`Native attachment ${file.id} has no matching authorized asset`),
          {
            code: 'native_asset_not_found',
          }
        );
      }
      if (!readAsset) {
        throw Object.assign(
          new Error('Native attachment reads require an authorized binary reader'),
          {
            code: 'native_asset_reader_required',
          }
        );
      }
      const advertised = mapping.blob.bytes;
      const cached = resolvedBlobs.get(mapping.blob.hash);
      const claimed = claimedBytes.get(mapping.blob.hash) ?? cached?.bytes;
      if (claimed !== undefined && claimed !== advertised) {
        throw new Error('Native asset mappings disagree about blob size');
      }
      claimedBytes.set(mapping.blob.hash, advertised);
      if (cached === undefined && !queuedHashes.has(mapping.blob.hash)) {
        queuedHashes.add(mapping.blob.hash);
        missing.push({ hash: mapping.blob.hash, bytes: advertised });
      }
      wants.push({ file, hash: mapping.blob.hash, bytes: advertised });
    }
  }
  if (!readAsset) return assetURLs;
  await readWithBoundedConcurrency(
    SNAPSHOT_ASSET_READ_CONCURRENCY,
    missing.map(({ hash, bytes }) => async () => {
      const buffer = await readAsset(`${path}/blobs/${hash}`, bytes);
      if (buffer.byteLength !== bytes) {
        throw Object.assign(
          new Error('Native attachment bytes do not match the authorized blob size'),
          {
            code: 'blob_hash_mismatch',
          }
        );
      }
      viewBytesAsBase64(buffer, base64 => resolvedBlobs.set(hash, { bytes, base64 }));
    })
  );
  for (const want of wants) {
    const cached = resolvedBlobs.get(want.hash);
    if (!cached) throw new Error('Native asset read was skipped');
    assetURLs[kilo2AssetKey(want.file.id, want.file.uri, want.file.mime)] =
      `data:${want.file.mime};base64,${cached.base64}`;
  }
  return assetURLs;
}

function reconstructMessages(
  entities: ResolvedEntity[],
  position: number
): NativeSnapshotMessage[] {
  const parts = new Map<string, ResolvedEntity[]>();
  for (const item of entities) {
    if (item.entity.kind !== 'message-part') continue;
    // Keep malformed parts associated with their message, so they cannot turn a
    // partially readable envelope into an apparently complete transcript.
    const messageID =
      record(item.value) && typeof item.value['messageID'] === 'string'
        ? item.value['messageID']
        : item.entity.id.slice(0, item.entity.id.lastIndexOf('/'));
    const group = parts.get(messageID);
    if (group) group.push(item);
    else parts.set(messageID, [item]);
  }

  const messages: NativeSnapshotMessage[] = [];
  for (const item of entities) {
    if (item.entity.kind !== 'message') continue;
    const envelope = messageSchema.parse(item.value);
    const message = envelope.message;
    if (message.id !== item.entity.id) throw new Error('Native message entity identity mismatch');
    const output: NativeSnapshotMessage = { message, seq: envelope.seq };
    if (envelope['parts'] !== undefined) {
      const frontier = partsSchema.safeParse(envelope['parts']);
      const matching = parts.get(message.id) ?? [];
      const ordered: { ordinal: number; part: unknown }[] = [];
      const ordinals = new Set<number>();
      let complete =
        message.type === 'assistant' &&
        !Object.hasOwn(message, 'content') &&
        frontier.success &&
        position >= frontier.data.through &&
        matching.length === frontier.data.count;
      if (complete && frontier.success) {
        for (const candidate of matching) {
          const parsed = partSchema.safeParse(candidate.value);
          if (
            !parsed.success ||
            parsed.data.messageID !== message.id ||
            candidate.entity.id !== `${message.id}/${parsed.data.ordinal}` ||
            parsed.data.position > frontier.data.through ||
            ordinals.has(parsed.data.ordinal)
          ) {
            complete = false;
            break;
          }
          ordinals.add(parsed.data.ordinal);
          ordered.push({ ordinal: parsed.data.ordinal, part: parsed.data.part });
        }
      }
      if (complete) {
        ordered.sort((a, b) => a.ordinal - b.ordinal);
        const reconstructed = { ...message, content: ordered.map(part => part.part) };
        const parsed = nativeMessageSchema.safeParse(reconstructed);
        if (parsed.success) {
          output.message = parsed.data;
          output.partOrdinals = ordered.map(part => part.ordinal);
        } else {
          output.incomplete = true;
        }
      } else {
        output.incomplete = true;
      }
    } else if (message.type === 'assistant' && !Array.isArray(message.content)) {
      output.incomplete = true;
    }
    messages.push(output);
  }
  messages.sort((a, b) => a.seq - b.seq || a.message.id.localeCompare(b.message.id));
  return messages;
}

async function readSnapshot(
  request: Request,
  sessionID: string,
  readAsset?: NativeAssetReader,
  resolvedEntities: Map<string, unknown> = new Map(),
  resolvedAssetBlobs: Map<string, { bytes: number; base64: string }> = new Map()
): Promise<NativeSnapshot> {
  const path = `/v1/sessions/${encodeURIComponent(sessionID)}`;
  const state = stateSchema.parse(await request<unknown>(path));
  if (state.sessionID !== sessionID) throw new Error('Native snapshot session identity mismatch');
  if (state.deleted) {
    throw Object.assign(new Error('The native session has been deleted'), {
      code: 'session_deleted',
    });
  }

  const entities: NativeEntity[] = [];
  const identities = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = `revision=${state.revision}&limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page = pageSchema.parse(await request<unknown>(`${path}/entities?${query}`));
    if (page.sessionID !== sessionID)
      throw new Error('Native entity page session identity mismatch');
    if (page.revision !== state.revision) throw snapshotChanged();
    if (page.position !== state.position)
      throw new Error('Native snapshot source position mismatch');
    for (const entity of page.entities) {
      const identity = `${entity.kind}/${entity.id}`;
      if (identities.has(identity) || entity.revision > state.revision) {
        throw new Error('Native snapshot contains inconsistent entities');
      }
      identities.add(identity);
      entities.push(entity);
    }
    if (entities.length > 100_000) throw new Error('Native snapshot exceeds the entity limit');
    cursor = page.next;
    if (cursor !== null) {
      if (cursors.has(cursor) || page.entities.length === 0) {
        throw new Error('Native snapshot entity cursor did not advance');
      }
      cursors.add(cursor);
    }
  } while (cursor !== null);

  const resolved: ResolvedEntity[] = [];
  // Collect blob-backed entities in appearance order and read each distinct
  // body once, concurrently within the bounded window. Content-addressed
  // entries cached from a previous retry attempt are reused as-is.
  const pending: { entity: NativeEntity; hash: string }[] = [];
  const hashes = new Set<string>();
  for (const entity of entities) {
    if ('value' in entity) {
      resolved.push({ entity, value: entity.value });
      continue;
    }
    // Bare asset blob references are raw bytes, not entity JSON. Resolve only
    // explicit inline mappings bound to authoritative native attachment positions.
    if (entity.kind === 'asset') continue;
    pending.push({ entity, hash: entity.blob.hash });
    hashes.add(entity.blob.hash);
  }
  await readWithBoundedConcurrency(
    SNAPSHOT_READ_CONCURRENCY,
    [...hashes]
      .filter(hash => !resolvedEntities.has(hash))
      .map(hash => async () => {
        // Non-asset entity bodies are canonical JSON.
        const value = z.json().parse(await request<unknown>(`${path}/blobs/${hash}`));
        resolvedEntities.set(hash, value);
      })
  );
  for (const item of pending) {
    const value = resolvedEntities.get(item.hash);
    if (value === undefined) throw new Error('Native snapshot blob read was skipped');
    resolved.push({ entity: item.entity, value });
  }
  let session: NativeSnapshotSession | undefined;
  for (const item of resolved) {
    if (item.entity.kind !== 'session') continue;
    const parsed = nativeSnapshotSessionSchema.parse(item.value);
    if (item.entity.id !== sessionID || parsed.id !== sessionID) {
      throw new Error('Native session entity identity mismatch');
    }
    session = parsed;
  }
  const snapshot: NativeSnapshot = {
    position: state.position,
    revision: state.revision,
    ...(session === undefined ? {} : { session }),
    messages: reconstructMessages(resolved, state.position),
    entities,
  };
  const assetURLs = await resolveSnapshotAssets(
    snapshot,
    resolved,
    path,
    readAsset,
    resolvedAssetBlobs
  );
  if (Object.keys(assetURLs).length > 0) snapshot.assetURLs = assetURLs;
  return snapshot;
}

/**
 * Read one revision-consistent native snapshot, pinning even its first entity
 * page to the inspected state. Requests JSON-decode entity blobs and surface
 * service errors with a `code` property. Revision races and reclaimed blobs
 * restart from state, at most three complete attempts; content-addressed blob
 * and attachment reads settled by an earlier attempt are reused, and the rest
 * resolve with a small bounded pool rather than one request at a time. Reads
 * have a two-minute total deadline, a 15-second request deadline, and
 * non-cooperative cancellation. The optional binary reader must use the same
 * session/tenant authorization as JSON reads and bound streamed bytes to the
 * advertised blob size. Stored media requires it; authorized bytes become
 * content-bound data URLs without modifying canonical messages or exposing
 * credentials.
 */
export async function fetchNativeSnapshot(
  request: Request,
  sessionID: string,
  signal?: AbortSignal,
  readAsset?: NativeAssetReader
): Promise<NativeSnapshot> {
  sessionIDSchema.parse(sessionID);
  const controller = new AbortController();
  let failure = new Error('Native snapshot read canceled');
  const cancel = () => controller.abort();
  const timeout = setTimeout(() => {
    failure = new Error('Native snapshot read timed out');
    controller.abort();
  }, 120_000);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const runRequest = <T>(operation: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      if (controller.signal.aborted) {
        reject(failure);
        return;
      }
      const requestTimeout = setTimeout(() => {
        failure = new Error('Native snapshot request timed out');
        controller.abort();
      }, 15_000);
      const abort = () => {
        clearTimeout(requestTimeout);
        reject(failure);
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      void operation().then(
        value => {
          clearTimeout(requestTimeout);
          controller.signal.removeEventListener('abort', abort);
          if (controller.signal.aborted) reject(failure);
          else resolve(value);
        },
        error => {
          clearTimeout(requestTimeout);
          controller.signal.removeEventListener('abort', abort);
          reject(error);
        }
      );
    });
  const cancellable: Request = <T>(path: string) =>
    runRequest(() => request<T>(path, { signal: controller.signal }));
  const cancellableAsset = readAsset
    ? (path: string, advertisedBytes: number) =>
        runRequest(() => readAsset(path, advertisedBytes, { signal: controller.signal }))
    : undefined;
  // Content-addressed reads already settled stay cached across retry
  // attempts; an unchanged body cannot return different bytes.
  const resolvedEntities = new Map<string, unknown>();
  const resolvedBlobs = new Map<string, { bytes: number; base64: string }>();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await readSnapshot(
          cancellable,
          sessionID,
          cancellableAsset,
          resolvedEntities,
          resolvedBlobs
        );
      } catch (error) {
        if (
          controller.signal.aborted ||
          attempt >= 2 ||
          !record(error) ||
          (error['code'] !== 'revision_changed' && error['code'] !== 'blob_not_found')
        ) {
          throw error;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
