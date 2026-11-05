import { z } from 'zod';

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
    blob: z.strictObject({
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z
        .number()
        .int()
        .min(0)
        .max(8 * 1024 * 1024),
    }),
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
  message: z.looseObject({ id: idSchema, type: z.string().min(1) }),
});
const partsSchema = z.strictObject({ count: positionSchema, through: positionSchema });
const partSchema = z.strictObject({
  messageID: idSchema,
  ordinal: positionSchema,
  position: positionSchema,
  part: z.record(z.string(), z.json()),
});

type Request = <T>(path: string) => Promise<T>;
type ResolvedEntity = { entity: NativeEntity; value: unknown };

/** Portable wire entities; blob references remain available to callers. */
export type NativeEntity = z.infer<typeof entitySchema>;

export type NativeMessage = {
  id: string;
  role: string;
  content: unknown;
  seq: number;
  /** Source ordinals aligned with content, which need not be contiguous. */
  partOrdinals?: number[];
  incomplete?: boolean;
};

export type NativeSnapshot = {
  position: number;
  revision: number;
  messages: NativeMessage[];
  entities: NativeEntity[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshotChanged(): Error & { code: string } {
  return Object.assign(new Error('The native session changed while reading its snapshot'), {
    code: 'revision_changed',
  });
}

function reconstructMessages(entities: ResolvedEntity[], position: number): NativeMessage[] {
  const parts = new Map<string, ResolvedEntity[]>();
  for (const item of entities) {
    if (item.entity.kind !== 'message-part') continue;
    // Keep malformed parts associated with their message, so they cannot turn a
    // partially readable envelope into an apparently complete transcript.
    const messageID =
      record(item.value) && typeof item.value.messageID === 'string'
        ? item.value.messageID
        : item.entity.id.slice(0, item.entity.id.lastIndexOf('/'));
    const group = parts.get(messageID);
    if (group) group.push(item);
    else parts.set(messageID, [item]);
  }

  const messages: NativeMessage[] = [];
  for (const item of entities) {
    if (item.entity.kind !== 'message') continue;
    const envelope = messageSchema.parse(item.value);
    const message = envelope.message;
    if (message.id !== item.entity.id) throw new Error('Native message entity identity mismatch');
    const output: NativeMessage = {
      id: message.id,
      role: message.type,
      content: message.content ?? message.text ?? message,
      seq: envelope.seq,
    };
    if (envelope.parts !== undefined) {
      const frontier = partsSchema.safeParse(envelope.parts);
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
        output.content = ordered.map(part => part.part);
        output.partOrdinals = ordered.map(part => part.ordinal);
      } else {
        output.content = [];
        output.incomplete = true;
      }
    } else if (message.type === 'assistant' && !Array.isArray(message.content)) {
      output.content = [];
      output.incomplete = true;
    }
    messages.push(output);
  }
  messages.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  return messages;
}

async function readSnapshot(request: Request, sessionID: string): Promise<NativeSnapshot> {
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
  const blobs = new Map<string, unknown>();
  for (const entity of entities) {
    if ('value' in entity) {
      resolved.push({ entity, value: entity.value });
      continue;
    }
    if (!blobs.has(entity.blob.hash)) {
      // Entity bodies are JSON, unlike the asset bytes referenced inside them.
      blobs.set(
        entity.blob.hash,
        z.json().parse(await request<unknown>(`${path}/blobs/${entity.blob.hash}`))
      );
    }
    resolved.push({ entity, value: blobs.get(entity.blob.hash) });
  }
  return {
    position: state.position,
    revision: state.revision,
    messages: reconstructMessages(resolved, state.position),
    entities,
  };
}

/**
 * Read one revision-consistent native snapshot, pinning even its first entity
 * page to the inspected state. Requests JSON-decode entity blobs and surface
 * service errors with a `code` property. Revision races and reclaimed blobs
 * restart from state, at most three complete attempts; other failures propagate.
 */
export async function fetchNativeSnapshot(
  request: Request,
  sessionID: string
): Promise<NativeSnapshot> {
  sessionIDSchema.parse(sessionID);
  for (let attempt = 0; ; attempt++) {
    try {
      return await readSnapshot(request, sessionID);
    } catch (error) {
      if (
        attempt >= 2 ||
        !record(error) ||
        (error.code !== 'revision_changed' && error.code !== 'blob_not_found')
      ) {
        throw error;
      }
    }
  }
}
