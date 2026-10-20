import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { z } from 'zod';
import { withTimeout } from '@kilocode/worker-utils';
import {
  kiloSdkSessionSnapshotOutcomeSchema,
  persistedKiloSdkMessageHistorySchema,
} from '@kilocode/session-ingest-contracts';
import type { SessionIngestBinding } from '../../session-ingest-binding.js';
import { MAX_INGEST_EVENT_BYTES, slimPersistedKilocodeEvent } from '../../shared/ingest-frame.js';
import type { StoredEvent } from '../../websocket/types.js';
import type { SessionEventQueries } from './event-queries.js';
import { persistSessionEvent, readNativeEventPayload } from './native-events.js';
import { events, historyImport } from './sqlite-schema.js';

const HYDRATION_KEY = 'client_history_hydration';
const encoder = new TextEncoder();
const hydrationStateSchema = z.object({
  phase: z.enum(['reading', 'applying', 'metadata', 'complete']),
  before: z.string().optional(),
  pageSize: z.number().int().min(1).max(100).default(100),
  omittedItemCount: z.number().int().nonnegative(),
});
type HydrationState = z.infer<typeof hydrationStateSchema>;

function hydrationKey(kiloSessionId?: string) {
  return kiloSessionId === undefined ? HYDRATION_KEY : `${HYDRATION_KEY}/${kiloSessionId}`;
}

export function markHistoryHydrated(storage: DurableObjectStorage, kiloSessionId?: string) {
  storage.kv.put(hydrationKey(kiloSessionId), { phase: 'complete', omittedItemCount: 0 });
}

export function readHistoryHydration(storage: DurableObjectStorage, kiloSessionId?: string) {
  const parsed = hydrationStateSchema.safeParse(storage.kv.get(hydrationKey(kiloSessionId)));
  return parsed.success ? parsed.data : undefined;
}

async function readHistoryExport(
  body: ReadableStream<unknown>,
  item: (kind: 'info' | 'message', value: unknown, oversized: boolean) => void,
  checkCurrent: () => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let phase: 'key' | 'colon' | 'value' | 'after' = 'key';
  let key = '';
  let keyText: string | undefined;
  let capture:
    | { kind: 'info' | 'message'; depth: number; value: string; oversized: boolean }
    | undefined;
  let messages = false;
  let started = false;
  let complete = false;
  let messagePhase: 'first' | 'value' | 'after' = 'first';
  let rootComma = false;
  let primitive = '';
  const consume = (chunk: string) => {
    for (const character of chunk) {
      if (complete) {
        if (!/\s/.test(character)) throw new Error('Invalid session history archive');
        continue;
      }
      if (!started) {
        if (/\s/.test(character)) continue;
        if (character !== '{') throw new Error('Invalid session history archive');
        started = true;
        depth = 1;
        continue;
      }
      if (keyText !== undefined) {
        keyText += character;
        if (keyText.length > 1024) throw new Error('Invalid session history archive key');
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') {
          key = z.string().parse(JSON.parse(keyText));
          keyText = undefined;
          phase = 'colon';
        }
        continue;
      }
      if (!quoted && depth === 1 && capture === undefined) {
        if (/\s/.test(character)) continue;
        if (phase === 'key') {
          if (character === '}') {
            if (rootComma) throw new Error('Invalid session history archive');
            complete = true;
            depth = 0;
            continue;
          }
          if (character !== '"') throw new Error('Invalid session history archive key');
          keyText = '"';
          rootComma = false;
          continue;
        }
        if (phase === 'colon') {
          if (character !== ':') throw new Error('Invalid session history archive');
          phase = 'value';
          continue;
        }
        if (phase === 'after') {
          if (primitive !== '') {
            JSON.parse(primitive);
            primitive = '';
          }
          if (character === ',') {
            phase = 'key';
            rootComma = true;
            continue;
          }
          if (character === '}') {
            complete = true;
            depth = 0;
            continue;
          }
          throw new Error('Invalid session history archive');
        }
        if (key === 'messages') {
          if (character !== '[') throw new Error('Invalid session history messages');
          messages = true;
          messagePhase = 'first';
        } else if (key === 'info') {
          if (character !== '{') throw new Error('Invalid session history info');
          capture = { kind: 'info', depth: 1, value: '', oversized: false };
        } else if (character !== '{' && character !== '[' && character !== '"') {
          if (character === ',' || character === '}') {
            JSON.parse(primitive);
            primitive = '';
            if (character === ',') {
              phase = 'key';
              rootComma = true;
            } else {
              complete = true;
              depth = 0;
            }
          } else primitive += character;
          continue;
        }
      }
      if (!quoted && messages && depth === 2 && capture === undefined) {
        if (/\s/.test(character)) continue;
        if (messagePhase === 'after') {
          if (character === ',') {
            messagePhase = 'value';
            continue;
          }
          if (character !== ']') throw new Error('Invalid session history messages');
        } else if (character === ']' && messagePhase === 'value') {
          throw new Error('Invalid session history messages');
        }
        if (character !== ']') {
          if (character !== '{') throw new Error('Invalid session history message');
          capture = { kind: 'message', depth: 2, value: '', oversized: false };
        }
      }
      if (capture !== undefined && !capture.oversized) {
        capture.value += character;
        if (capture.value.length > MAX_INGEST_EVENT_BYTES) {
          capture.value = '';
          capture.oversized = true;
        }
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') depth -= 1;
      if (depth < 1) throw new Error('Invalid session history archive');
      if (capture !== undefined && !quoted && depth === capture.depth) {
        const oversized =
          capture.oversized || encoder.encode(capture.value).byteLength > MAX_INGEST_EVENT_BYTES;
        item(capture.kind, oversized ? undefined : JSON.parse(capture.value), oversized);
        if (capture.kind === 'message') messagePhase = 'after';
        capture = undefined;
      }
      if (!quoted && depth === 1) {
        messages = false;
        phase = 'after';
      }
    }
  };
  try {
    for (;;) {
      checkCurrent();
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array))
        throw new Error('Invalid session history archive chunk');
      consume(decoder.decode(next.value, { stream: true }));
    }
    consume(decoder.decode());
    if (!complete || quoted || capture !== undefined || keyText !== undefined)
      throw new Error('Incomplete session history archive');
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function hydrateSessionHistory(input: {
  db: DrizzleSqliteDODatabase;
  storage: DurableObjectStorage;
  ingest: SessionIngestBinding;
  queries: SessionEventQueries;
  sessionId: string;
  kiloSessionId: string;
  rootKiloSessionId?: string;
  userId: string;
  internalSecret?: string;
  isCurrent: () => boolean;
  broadcast: (event: StoredEvent) => void;
}): Promise<void> {
  const isRoot =
    input.rootKiloSessionId === undefined || input.kiloSessionId === input.rootKiloSessionId;
  const key = hydrationKey(isRoot ? undefined : input.kiloSessionId);
  const scope = isRoot ? '' : input.kiloSessionId;
  const storedState = readHistoryHydration(input.storage, isRoot ? undefined : input.kiloSessionId);
  if (storedState?.phase === 'complete') return;
  let state: HydrationState = storedState ?? {
    phase: 'reading',
    pageSize: 100,
    omittedItemCount: 0,
  };
  const deadline = Date.now() + 20_000;
  const checkCurrent = () => {
    if (!input.isCurrent()) throw new Error('Session history hydration was retired');
    if (Date.now() >= deadline) throw new Error('Session history hydration is still in progress');
  };
  const hasInfo = () => {
    const row = input.queries.findByEntityId(`session/${input.kiloSessionId}`);
    return (
      row !== null &&
      z
        .object({ id: z.literal(input.kiloSessionId) })
        .safeParse(readNativeEventPayload(row.payload)?.properties.info).success
    );
  };
  const stage = (
    entityId: string,
    event: string,
    properties: Record<string, unknown>,
    timestamp: number
  ) => {
    const payload = JSON.stringify(slimPersistedKilocodeEvent({ type: event, event, properties }));
    if (encoder.encode(payload).byteLength > MAX_INGEST_EVENT_BYTES) {
      state.omittedItemCount += 1;
      return;
    }
    input.db
      .insert(historyImport)
      .values({ entity_id: entityId, kilo_session_id: scope, payload, timestamp })
      .onConflictDoNothing()
      .run();
  };
  const stageMessage = (value: unknown) => {
    const parsed = z
      .object({
        info: z
          .object({
            id: z.string().min(1).max(256),
            sessionID: z.literal(input.kiloSessionId),
            time: z.object({ created: z.number().finite() }).passthrough(),
          })
          .passthrough(),
        parts: z.array(
          z
            .object({
              id: z.string().min(1).max(256),
              messageID: z.string(),
              sessionID: z.literal(input.kiloSessionId),
              type: z.string(),
            })
            .passthrough()
        ),
      })
      .parse(value);
    for (const part of parsed.parts)
      if (part.messageID !== parsed.info.id) throw new Error('Hydrated part identity mismatch');
    stage(
      `message/${parsed.info.id}`,
      'message.updated',
      { info: parsed.info },
      parsed.info.time.created
    );
    for (const part of parsed.parts)
      stage(
        `part/${parsed.info.id}/${part.id}`,
        'message.part.updated',
        { part },
        parsed.info.time.created
      );
  };

  if (!isRoot && state.phase !== 'applying') {
    input.db.delete(historyImport).where(eq(historyImport.kilo_session_id, scope)).run();
    state = { phase: 'reading', pageSize: 100, omittedItemCount: 0 };
    const response = await input.ingest.fetch(
      new Request(
        `https://session-ingest/internal/session/${encodeURIComponent(input.kiloSessionId)}/export`,
        {
          headers: {
            'X-Internal-Secret': input.internalSecret ?? '',
            'X-Kilo-User-Id': input.userId,
          },
          signal: AbortSignal.timeout(20_000),
        }
      )
    );
    checkCurrent();
    if (response.status === 404) return;
    if (!response.ok || response.body === null)
      throw new Error('Session history export is unavailable');
    let foundInfo = false;
    await readHistoryExport(
      response.body,
      (kind, value, oversized) => {
        checkCurrent();
        if (oversized) {
          state.omittedItemCount += 1;
          return;
        }
        if (kind === 'message') {
          stageMessage(value);
          return;
        }
        const info = z
          .object({
            id: z.literal(input.kiloSessionId),
            time: z.object({ updated: z.number().finite() }).passthrough().optional(),
          })
          .passthrough()
          .parse(value);
        foundInfo = true;
        stage(
          `session/${input.kiloSessionId}`,
          'session.updated',
          { info },
          info.time?.updated ?? 0
        );
      },
      checkCurrent
    );
    if (!foundInfo) throw new Error('Session history export identity mismatch');
    state = { ...state, phase: 'applying' };
    input.storage.kv.put(key, state);
  }
  if (isRoot) {
    if (state.phase === 'metadata' && hasInfo()) {
      input.storage.kv.put(key, { ...state, phase: 'complete' });
      return;
    }
    if (storedState === undefined || state.phase === 'metadata') {
      const snapshot = await withTimeout(
        input.ingest.getCloudAgentRootSessionSnapshot({
          kiloUserId: input.userId,
          kiloSessionId: input.kiloSessionId,
        }),
        10_000,
        'Session history snapshot hydration timed out'
      );
      checkCurrent();
      if (
        snapshot !== null &&
        (snapshot.kiloSessionId !== input.kiloSessionId ||
          snapshot.cloudAgentSessionId !== input.sessionId)
      )
        throw new Error('Session history snapshot identity mismatch');
      const parsed =
        snapshot === null
          ? undefined
          : kiloSdkSessionSnapshotOutcomeSchema.parse(snapshot.snapshot);
      if (state.phase === 'metadata' && (parsed === undefined || parsed.kind === 'pending')) return;
      if (parsed?.kind === 'value')
        stage(
          `session/${input.kiloSessionId}`,
          'session.updated',
          { info: parsed.info },
          parsed.info.time.updated
        );
      else if (parsed !== undefined && parsed.kind !== 'pending')
        throw new Error('Session history snapshot is unavailable');
      state = { ...state, phase: state.phase === 'metadata' ? 'applying' : 'reading' };
      input.storage.kv.put(key, state);
    }
    while (state.phase === 'reading') {
      checkCurrent();
      const result = await withTimeout(
        input.ingest.getCloudAgentRootSessionMessages({
          kiloUserId: input.userId,
          kiloSessionId: input.kiloSessionId,
          limit: state.pageSize,
          ...(state.before === undefined ? {} : { before: state.before }),
        }),
        Math.min(10_000, Math.max(1, deadline - Date.now())),
        'Session message hydration timed out'
      );
      checkCurrent();
      if (result === null || result.history === null) return;
      if (
        result.kiloSessionId !== input.kiloSessionId ||
        result.cloudAgentSessionId !== input.sessionId
      )
        throw new Error('Session history identity mismatch');
      const page = persistedKiloSdkMessageHistorySchema.parse(result.history);
      if ('kind' in page) {
        if (page.kind !== 'too_large' || state.pageSize === 1)
          throw new Error('Session message hydration is unavailable');
        state = { ...state, pageSize: Math.max(1, Math.floor(state.pageSize / 2)) };
        input.storage.kv.put(key, state);
        continue;
      }
      if (page.nextCursor !== null && page.nextCursor === state.before)
        throw new Error('Session message hydration did not advance');
      input.storage.transactionSync(() => {
        for (const message of page.messages) stageMessage(message);
        state = {
          phase: page.nextCursor === null ? 'applying' : 'reading',
          ...(page.nextCursor === null ? {} : { before: page.nextCursor }),
          pageSize: state.pageSize,
          omittedItemCount: state.omittedItemCount + page.omittedItemCount,
        };
        input.storage.kv.put(key, state);
      });
    }
  }
  const removed = (messageId: string, partId?: string) =>
    input.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.session_id, input.sessionId),
          eq(events.stream_event_type, 'kilocode'),
          eq(
            sql<string>`json_extract(${events.payload}, '$.properties.sessionID')`,
            input.kiloSessionId
          ),
          eq(sql<string>`json_extract(${events.payload}, '$.properties.messageID')`, messageId),
          partId === undefined
            ? eq(sql<string>`json_extract(${events.payload}, '$.event')`, 'message.removed')
            : or(
                eq(sql<string>`json_extract(${events.payload}, '$.event')`, 'message.removed'),
                and(
                  eq(
                    sql<string>`json_extract(${events.payload}, '$.event')`,
                    'message.part.removed'
                  ),
                  eq(sql<string>`json_extract(${events.payload}, '$.properties.partID')`, partId)
                )
              )
        )
      )
      .limit(1)
      .get() !== undefined;
  for (;;) {
    checkCurrent();
    const rows = input.db
      .select()
      .from(historyImport)
      .where(eq(historyImport.kilo_session_id, scope))
      .orderBy(asc(historyImport.timestamp), asc(historyImport.entity_id))
      .limit(20)
      .all();
    if (rows.length === 0) break;
    for (const row of rows) {
      const event = readNativeEventPayload(row.payload);
      if (event === undefined) throw new Error('Invalid staged session history');
      const message = z.object({ id: z.string() }).safeParse(event.properties.info);
      const part = z
        .object({ id: z.string(), messageID: z.string() })
        .safeParse(event.properties.part);
      const isRemoved =
        message.success && event.event === 'message.updated'
          ? removed(message.data.id)
          : part.success && removed(part.data.messageID, part.data.id);
      if (!isRemoved && !(event.event === 'session.updated' && hasInfo())) {
        const stored = persistSessionEvent({
          sessionId: input.sessionId,
          event: {
            type: event.event,
            properties: event.properties,
            timestamp: new Date(row.timestamp).toISOString(),
          },
          queries: input.queries,
          seed: true,
        });
        if (stored !== null) input.broadcast(stored);
      }
      input.db.delete(historyImport).where(eq(historyImport.entity_id, row.entity_id)).run();
    }
  }
  input.storage.kv.put(key, {
    phase: hasInfo() ? 'complete' : 'metadata',
    omittedItemCount: state.omittedItemCount,
  });
}
