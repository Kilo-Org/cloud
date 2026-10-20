import { and, asc, count, desc, eq, gt, gte, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { sessionIdSchema } from '@kilocode/session-ingest-contracts';
import { z } from 'zod';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { SessionEventQueries } from './event-queries.js';
import { events } from './sqlite-schema.js';

export const MAX_SESSION_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_CURSOR_LENGTH = 2048;
const encoder = new TextEncoder();
const nativeInfoSchema = z.object({ id: z.string().min(1).max(256) }).passthrough();
const messageInfoSchema = nativeInfoSchema.extend({
  sessionID: z.string(),
  role: z.enum(['user', 'assistant']),
});
const partSchema = nativeInfoSchema.extend({
  messageID: z.string(),
  sessionID: z.string(),
  type: z.string(),
});

export const sessionHistoryPageInputSchema = z
  .object({
    cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    kiloSessionId: sessionIdSchema.optional(),
    expectedRootKiloSessionId: sessionIdSchema.optional(),
  })
  .strict();

const cursorSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1).max(256),
    rootKiloSessionId: sessionIdSchema,
    kiloSessionId: sessionIdSchema,
    createdAt: z.number().finite(),
    messageId: z.string().max(256),
    rowId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
type HistoryCursor = z.infer<typeof cursorSchema>;

function encodeCursor(cursor: HistoryCursor): string {
  let binary = '';
  for (const byte of encoder.encode(JSON.stringify(cursor))) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeSessionHistoryCursor(cursor: string): HistoryCursor {
  try {
    if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const binary = atob(
      cursor.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (cursor.length % 4)) % 4)
    );
    return cursorSchema.parse(
      JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))))
    );
  } catch {
    throw new Error('Invalid session history cursor');
  }
}

function parseItem<T>(raw: string | null | undefined, schema: z.ZodType<T>): T | undefined {
  if (raw == null) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type SessionMessagesPage = {
  kind: 'success';
  info: z.infer<typeof nativeInfoSchema>;
  messages: Array<{ info: z.infer<typeof messageInfoSchema>; parts: z.infer<typeof partSchema>[] }>;
  nextCursor: string | null;
  omittedItemCount: number;
  updateCursor: number;
  totalCostMicrodollars: number;
};

export function readSessionMessagesPage(input: {
  db: DrizzleSqliteDODatabase;
  storage: DurableObjectStorage;
  queries: SessionEventQueries;
  sessionId: string;
  rootKiloSessionId: string;
  kiloSessionId: string;
  cursor?: string;
  limit?: number;
  metadata: SessionMetadata | null;
  parentID?: string;
  omittedItemCount?: number;
}): SessionMessagesPage {
  const { db, sessionId, rootKiloSessionId, kiloSessionId } = input;
  const cursor = input.cursor === undefined ? undefined : decodeSessionHistoryCursor(input.cursor);
  if (
    cursor !== undefined &&
    (cursor.sessionId !== sessionId ||
      cursor.rootKiloSessionId !== rootKiloSessionId ||
      cursor.kiloSessionId !== kiloSessionId)
  ) {
    throw new Error('Session history cursor belongs to another session');
  }
  const page: SessionMessagesPage = {
    kind: 'success',
    info: {
      id: kiloSessionId,
      ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
    },
    messages: [],
    nextCursor: null,
    omittedItemCount: cursor === undefined ? (input.omittedItemCount ?? 0) : 0,
    updateCursor: input.queries.getUpdateCursor(),
    totalCostMicrodollars: input.queries.getTotalCostMicrodollars(sessionId, kiloSessionId),
  };
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const envelopeBytes = () =>
    size({
      ...page,
      messages: [],
      nextCursor: 'x'.repeat(MAX_CURSOR_LENGTH),
      omittedItemCount: Number.MAX_SAFE_INTEGER,
    });
  const sessionWhere = and(
    eq(events.session_id, sessionId),
    eq(events.entity_id, `session/${kiloSessionId}`)
  );
  const sessionBytes = db
    .select({
      bytes: sql<number>`length(cast(json_extract(${events.payload}, '$.properties.info') as blob))`,
    })
    .from(events)
    .where(sessionWhere)
    .get()?.bytes;
  if (sessionBytes !== undefined && sessionBytes < MAX_SESSION_PAGE_BYTES - envelopeBytes()) {
    const info = parseItem(
      db
        .select({ value: sql<string>`json_extract(${events.payload}, '$.properties.info')` })
        .from(events)
        .where(sessionWhere)
        .get()?.value,
      nativeInfoSchema
    );
    if (info?.id === kiloSessionId)
      page.info = {
        ...info,
        ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
      };
    else page.omittedItemCount += 1;
  } else if (sessionBytes !== undefined) {
    page.omittedItemCount += 1;
  }
  if (envelopeBytes() > MAX_SESSION_PAGE_BYTES) {
    page.info = {
      id: kiloSessionId,
      ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
    };
    page.omittedItemCount += 1;
  }
  let bytes = envelopeBytes();
  const createdAt = sql<number>`case when json_type(${events.payload}, '$.properties.info.time.created') in ('integer', 'real') then json_extract(${events.payload}, '$.properties.info.time.created') else 0 end`;
  const messageId = sql<string>`case when json_type(${events.payload}, '$.properties.info.id') = 'text' and length(cast(json_extract(${events.payload}, '$.properties.info.id') as blob)) between 1 and 256 then json_extract(${events.payload}, '$.properties.info.id') else '' end`;
  const removals = alias(events, 'history_removals');
  const removalWhere = and(
    isNull(removals.entity_id),
    eq(removals.session_id, sessionId),
    eq(removals.stream_event_type, 'kilocode'),
    eq(sql<string>`json_extract(${removals.payload}, '$.properties.sessionID')`, kiloSessionId),
    gt(removals.mutation_cursor, events.mutation_cursor)
  );
  const before =
    cursor === undefined
      ? undefined
      : or(
          lt(createdAt, cursor.createdAt),
          and(eq(createdAt, cursor.createdAt), lt(messageId, cursor.messageId)),
          and(
            eq(createdAt, cursor.createdAt),
            eq(messageId, cursor.messageId),
            lt(events.id, cursor.rowId)
          )
        );
  const limit = input.limit ?? 50;
  const candidates = db
    .select({
      id: events.id,
      createdAt,
      messageId,
      bytes: sql<number>`length(cast(json_extract(${events.payload}, '$.properties.info') as blob))`,
    })
    .from(events)
    .where(
      and(
        eq(events.session_id, sessionId),
        eq(events.stream_event_type, 'kilocode'),
        eq(sql<string>`json_extract(${events.payload}, '$.event')`, 'message.updated'),
        eq(
          sql<string>`json_extract(${events.payload}, '$.properties.info.sessionID')`,
          kiloSessionId
        ),
        notExists(
          db
            .select({ id: removals.id })
            .from(removals)
            .where(
              and(
                removalWhere,
                eq(sql<string>`json_extract(${removals.payload}, '$.event')`, 'message.removed'),
                eq(
                  sql<string>`json_extract(${removals.payload}, '$.properties.messageID')`,
                  messageId
                )
              )
            )
        ),
        before
      )
    )
    .orderBy(desc(createdAt), desc(messageId), desc(events.id))
    .limit(limit + 1)
    .all();
  let consumed: HistoryCursor | undefined;
  let hasMore = candidates.length > limit;
  for (const candidate of candidates.slice(0, limit)) {
    const key: HistoryCursor = {
      version: 1,
      sessionId,
      rootKiloSessionId,
      kiloSessionId,
      createdAt: candidate.createdAt,
      messageId: candidate.messageId,
      rowId: candidate.id,
    };
    const partPrefix = `part/${candidate.messageId}/`;
    const partWhere = and(
      eq(events.session_id, sessionId),
      gte(events.entity_id, partPrefix),
      lt(events.entity_id, `${partPrefix.slice(0, -1)}0`),
      eq(sql<string>`json_extract(${events.payload}, '$.event')`, 'message.part.updated'),
      eq(
        sql<string>`json_extract(${events.payload}, '$.properties.part.sessionID')`,
        kiloSessionId
      ),
      eq(
        sql<string>`json_extract(${events.payload}, '$.properties.part.messageID')`,
        candidate.messageId
      ),
      notExists(
        db
          .select({ id: removals.id })
          .from(removals)
          .where(
            and(
              removalWhere,
              eq(sql<string>`json_extract(${removals.payload}, '$.event')`, 'message.part.removed'),
              eq(
                sql<string>`json_extract(${removals.payload}, '$.properties.messageID')`,
                candidate.messageId
              ),
              eq(
                sql<string>`json_extract(${removals.payload}, '$.properties.partID')`,
                sql<string>`json_extract(${events.payload}, '$.properties.part.id')`
              )
            )
          )
      )
    );
    const parts = db
      .select({
        count: count(),
        bytes: sql<number>`coalesce(sum(length(cast(json_extract(${events.payload}, '$.properties.part') as blob))), 0)`,
      })
      .from(events)
      .where(partWhere)
      .get();
    const partCount = parts?.count ?? 0;
    const messageBytes = candidate.bytes + (parts?.bytes ?? 0) + Math.max(0, partCount - 1) + 22;
    if (page.messages.length > 0 && bytes + messageBytes + 1 > MAX_SESSION_PAGE_BYTES) {
      hasMore = true;
      break;
    }
    consumed = key;
    if (candidate.bytes + bytes + 22 > MAX_SESSION_PAGE_BYTES) {
      page.omittedItemCount += 1 + partCount;
      continue;
    }
    const info = parseItem(
      db
        .select({ value: sql<string>`json_extract(${events.payload}, '$.properties.info')` })
        .from(events)
        .where(eq(events.id, candidate.id))
        .get()?.value,
      messageInfoSchema
    );
    if (info === undefined || info.sessionID !== kiloSessionId || info.id !== candidate.messageId) {
      page.omittedItemCount += 1 + partCount;
      continue;
    }
    const message: SessionMessagesPage['messages'][number] = { info, parts: [] };
    let messageSize = size(message);
    if (bytes + messageSize + 1 > MAX_SESSION_PAGE_BYTES) {
      page.omittedItemCount += 1 + partCount;
      continue;
    }
    let partCursor = '';
    let readParts = 0;
    while (readParts < partCount) {
      const batch = db
        .select({
          id: events.id,
          entityId: sql<string>`${events.entity_id}`,
          bytes: sql<number>`length(cast(json_extract(${events.payload}, '$.properties.part') as blob))`,
        })
        .from(events)
        .where(and(partWhere, gt(events.entity_id, partCursor)))
        .orderBy(asc(events.entity_id), asc(events.id))
        .limit(64)
        .all();
      if (batch.length === 0) break;
      let full = false;
      for (const row of batch) {
        partCursor = row.entityId;
        if (bytes + messageSize + row.bytes + 2 > MAX_SESSION_PAGE_BYTES) {
          page.omittedItemCount += partCount - readParts;
          full = true;
          break;
        }
        readParts += 1;
        const part = parseItem(
          db
            .select({ value: sql<string>`json_extract(${events.payload}, '$.properties.part')` })
            .from(events)
            .where(eq(events.id, row.id))
            .get()?.value,
          partSchema
        );
        if (part === undefined || part.messageID !== info.id || part.sessionID !== kiloSessionId) {
          page.omittedItemCount += 1;
          continue;
        }
        const partBytes = size(part) + (message.parts.length === 0 ? 0 : 1);
        if (bytes + messageSize + partBytes + 1 > MAX_SESSION_PAGE_BYTES) {
          page.omittedItemCount += partCount - readParts + 1;
          full = true;
          break;
        }
        message.parts.push(part);
        messageSize += partBytes;
      }
      if (full) break;
    }
    page.messages.push(message);
    bytes += messageSize + 1;
  }
  if (hasMore && consumed !== undefined) page.nextCursor = encodeCursor(consumed);
  page.messages.reverse();
  return page;
}
