import { z } from 'zod';

import  { type ChatDatabase } from '../store';

/**
 * The sync record one chat carries, in the `chats` row beside the harness
 * session id. `serverSessionId` is written once and never moved: a harness
 * clone rewrites `session_id` (see `moveChat`) and this row rides along, so
 * the mapping survives model and tool switches.
 */

export const SYNC_PHASES = ['local', 'pending', 'synced', 'diverged', 'deleted'] as const;
export type SyncPhase = (typeof SYNC_PHASES)[number];

const phaseSchema = z.enum(SYNC_PHASES);
const messageMapSchema = z.record(
  z.string(),
  z.object({ msgId: z.string(), seq: z.number().int().nonnegative() })
);

/** A map under construction, before it is written as {@link SyncMessageMap}. */
export type MutableMessageMap = Record<string, { msgId: string; seq: number }>;

/** Turn id to the portable message it uploads (or was imported) as. */
export type SyncMessageMap = Readonly<Record<string, { readonly msgId: string; readonly seq: number }>>;

export type SyncRecord = {
  readonly sessionId: string;
  readonly serverSessionId: string | null;
  readonly sourceId: string | null;
  readonly phase: SyncPhase;
  /** The server position last committed or pulled: the next batch's CAS `after`. */
  readonly acknowledged: number;
  readonly ackBatch: string | null;
  readonly ackDigest: string | null;
  /** Highest seq assigned locally or seen on a pull. */
  readonly maxSeq: number;
  /** Highest seq the server has acknowledged. */
  readonly ackedSeq: number;
  /** The frozen packet awaiting acknowledgement, resent byte-identically on retry. */
  readonly outbox: string | null;
  readonly messageMap: SyncMessageMap;
};

type SyncRow = {
  readonly session_id: string;
  readonly server_session_id: string | null;
  readonly sync_source_id: string | null;
  readonly sync_state: string;
  readonly sync_acknowledged: number;
  readonly sync_ack_batch: string | null;
  readonly sync_ack_digest: string | null;
  readonly sync_max_seq: number;
  readonly sync_acked_seq: number;
  readonly sync_outbox: string | null;
  readonly sync_message_map: string | null;
};

const COLUMNS =
  'session_id, server_session_id, sync_source_id, sync_state, sync_acknowledged, ' +
  'sync_ack_batch, sync_ack_digest, sync_max_seq, sync_acked_seq, sync_outbox, sync_message_map';

function parseMessageMap(raw: string | null): SyncMessageMap {
  if (raw === null || raw === '') {
    return {};
  }
  try {
    const parsed = messageMapSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function recordOf(row: SyncRow): SyncRecord {
  const phase = phaseSchema.safeParse(row.sync_state);
  return {
    sessionId: row.session_id,
    serverSessionId: row.server_session_id,
    sourceId: row.sync_source_id,
    phase: phase.success ? phase.data : 'local',
    acknowledged: row.sync_acknowledged,
    ackBatch: row.sync_ack_batch,
    ackDigest: row.sync_ack_digest,
    maxSeq: row.sync_max_seq,
    ackedSeq: row.sync_acked_seq,
    outbox: row.sync_outbox,
    messageMap: parseMessageMap(row.sync_message_map),
  };
}

/** The sync record of one chat by its harness session id, or null when the chat is unknown. */
export function syncRecordOf(db: ChatDatabase, sessionId: string): SyncRecord | null {
  const [row] = db.getAllSync<SyncRow>(`select ${COLUMNS} from chats where session_id = ?`, [
    sessionId,
  ]);
  return row === undefined ? null : recordOf(row);
}

/** The sync record of one chat by its server id, or null when no local chat carries it. */
export function syncRecordByServerId(db: ChatDatabase, serverSessionId: string): SyncRecord | null {
  const [row] = db.getAllSync<SyncRow>(`select ${COLUMNS} from chats where server_session_id = ?`, [
    serverSessionId,
  ]);
  return row === undefined ? null : recordOf(row);
}

/** Every chat that has ever synced in one scope: the list merge's local index. */
export function syncedRecordsOfScope(db: ChatDatabase, scope: string): SyncRecord[] {
  return db
    .getAllSync<SyncRow>(
      `select ${COLUMNS} from chats where scope = ? and server_session_id is not null`,
      [scope]
    )
    .map(recordOf);
}

/**
 * The chats of one scope that have never reached the server: the backfill's
 * work list, oldest first, so an upgrade uploads in the order the person
 * made them.
 */
export function unsyncedChatIdsOfScope(db: ChatDatabase, scope: string): string[] {
  return db
    .getAllSync<{ session_id: string }>(
      'select session_id from chats where scope = ? and server_session_id is null ' +
        'and sync_state != ? order by coalesce(created_at, updated_at) asc',
      [scope, 'deleted']
    )
    .map(row => row.session_id);
}

/** The fields one write of the record may change. `serverSessionId` is set once, apart. */
export type SyncRecordPatch = Partial<{
  readonly sourceId: string | null;
  readonly phase: SyncPhase;
  readonly acknowledged: number;
  readonly ackBatch: string | null;
  readonly ackDigest: string | null;
  readonly maxSeq: number;
  readonly ackedSeq: number;
  readonly outbox: string | null;
  readonly messageMap: SyncMessageMap;
}>;

const PATCH_COLUMNS = {
  sourceId: 'sync_source_id',
  phase: 'sync_state',
  acknowledged: 'sync_acknowledged',
  ackBatch: 'sync_ack_batch',
  ackDigest: 'sync_ack_digest',
  maxSeq: 'sync_max_seq',
  ackedSeq: 'sync_acked_seq',
  outbox: 'sync_outbox',
  messageMap: 'sync_message_map',
} satisfies Record<keyof SyncRecordPatch, string>;

/** Writes one patch of the sync record. An empty patch writes nothing. */
export function saveSyncRecord(db: ChatDatabase, sessionId: string, patch: SyncRecordPatch): void {
  const sets: string[] = [];
  const values: (string | number)[] = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof SyncRecordPatch, string][]) {
    const value = patch[key];
    if (value === undefined) {
      continue;
    }
    sets.push(`${column} = ?`);
    values.push(key === 'messageMap' ? JSON.stringify(value) : (value as string | number));
    if (values.at(-1) === null) {
      // SQLite binds a JS null through the same parameter slot; the database
      // shim only admits strings and numbers, so null writes ride as SQL.
      values.pop();
      sets[sets.length - 1] = `${column} = null`;
    }
  }
  if (sets.length === 0) {
    return;
  }
  db.runSync(`update chats set ${sets.join(', ')} where session_id = ?`, [...values, sessionId]);
}

/**
 * Stamps the server id onto a chat that has none. Refuses (returns the held
 * id) when the chat already carries a different one: a server id never
 * changes hands.
 */
export function stampServerSessionId(input: {
  readonly db: ChatDatabase;
  readonly sessionId: string;
  readonly serverSessionId: string;
  readonly sourceId: string;
}): string {
  const { db, sessionId, serverSessionId, sourceId } = input;
  const held = syncRecordOf(db, sessionId)?.serverSessionId;
  if (held !== null && held !== undefined) {
    return held;
  }
  db.runSync('update chats set server_session_id = ?, sync_source_id = ? where session_id = ?', [
    serverSessionId,
    sourceId,
    sessionId,
  ]);
  return serverSessionId;
}
