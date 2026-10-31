import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import {
  kilo2ConversationMessageSchema,
  kilo2ConversationSourceSchema,
  type Kilo2Message,
} from '@kilocode/session-ingest-contracts';
import { z } from 'zod';
import {
  decodeSessionHistoryCursor,
  encodeCursor,
  MAX_SESSION_PAGE_BYTES,
  type readSessionMessagesPage,
  type HistoryCursor,
} from './history.js';
import { events } from './sqlite-schema.js';

export type Kilo2MessagesPage = {
  kind: 'success';
  source: z.infer<typeof kilo2ConversationSourceSchema>;
  info: {
    id: string;
    parentID?: string;
    title?: string;
    model?: Kilo2MessagesPage['source']['session']['model'];
  };
  messages: Array<{ message: Kilo2Message; parentID?: string }>;
  nextCursor: string | null;
  omittedItemCount: number;
  updateCursor: number;
  totalCostMicrodollars: number;
};

type Input = Parameters<typeof readSessionMessagesPage>[0];

export function readConversationSource(input: Input) {
  const row = input.queries.findByEntityId(`conversation-source/${input.kiloSessionId}`);
  if (row === null) return undefined;
  const value = z
    .object({ properties: z.object({ source: kilo2ConversationSourceSchema }) })
    .parse(JSON.parse(row.payload));
  return value.properties.source;
}

/** The source owns its native message shape; pagination and ownership stay in Cloud. */
export function readKilo2MessagesPage(
  input: Input,
  source: Kilo2MessagesPage['source']
): Kilo2MessagesPage {
  const { db, sessionId, rootKiloSessionId, kiloSessionId } = input;
  const cursor = input.cursor === undefined ? undefined : decodeSessionHistoryCursor(input.cursor);
  if (
    cursor &&
    (cursor.sessionId !== sessionId ||
      cursor.rootKiloSessionId !== rootKiloSessionId ||
      cursor.kiloSessionId !== kiloSessionId)
  )
    throw new Error('Session history cursor belongs to another session');
  if (source.session.id !== kiloSessionId)
    throw new Error('Conversation source belongs to another session');
  const createdAt = sql<number>`json_extract(${events.payload}, '$.properties.message.time.created')`;
  const messageId = sql<string>`json_extract(${events.payload}, '$.properties.message.id')`;
  const scope = and(
    eq(events.session_id, sessionId),
    eq(events.stream_event_type, 'kilocode'),
    eq(sql<string>`json_extract(${events.payload}, '$.event')`, 'conversation.message.updated'),
    eq(sql<string>`json_extract(${events.payload}, '$.properties.sessionID')`, kiloSessionId)
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
  const page: Kilo2MessagesPage = {
    kind: 'success',
    source,
    info: {
      id: kiloSessionId,
      ...(source.session.model ? { model: source.session.model } : {}),
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(source.session.title ? { title: source.session.title } : {}),
    },
    messages: [],
    nextCursor: null,
    omittedItemCount: cursor ? 0 : (input.omittedItemCount ?? 0),
    updateCursor: input.queries.getUpdateCursor(),
    totalCostMicrodollars: input.queries.getTotalCostMicrodollars(sessionId, kiloSessionId),
  };
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  // Reserve the maximum cursor before accepting a native message. Read payloads
  // only after checking their stored size, as in the v1 history reader.
  let bytes = size({ ...page, nextCursor: 'x'.repeat(2048) });
  const limit = input.limit ?? 50;
  const rows = db
    .select({
      id: events.id,
      createdAt,
      messageId,
      bytes: sql<number>`length(cast(${events.payload} as blob))`,
    })
    .from(events)
    .where(and(scope, before))
    .orderBy(desc(createdAt), desc(messageId), desc(events.id))
    .limit(limit + 1)
    .all();
  let consumed: HistoryCursor | undefined;
  let more = rows.length > limit;
  for (const row of rows.slice(0, limit)) {
    const key: HistoryCursor = {
      version: 1,
      sessionId,
      rootKiloSessionId,
      kiloSessionId,
      createdAt: row.createdAt,
      messageId: row.messageId,
      rowId: row.id,
    };
    if (page.messages.length && bytes + row.bytes > MAX_SESSION_PAGE_BYTES) {
      more = true;
      break;
    }
    consumed = key;
    if (bytes + row.bytes > MAX_SESSION_PAGE_BYTES) {
      page.omittedItemCount++;
      continue;
    }
    const stored = db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.id, row.id))
      .get();
    const parsed = stored
      ? z
          .object({ properties: kilo2ConversationMessageSchema })
          .safeParse(JSON.parse(stored.payload))
      : undefined;
    if (
      !parsed?.success ||
      parsed.data.properties.sessionID !== kiloSessionId ||
      parsed.data.properties.message.id !== row.messageId
    ) {
      page.omittedItemCount++;
      continue;
    }
    const item = {
      message: parsed.data.properties.message,
      ...(parsed.data.properties.parentID ? { parentID: parsed.data.properties.parentID } : {}),
    };
    page.messages.push(item);
    bytes += size(item) + 1;
  }
  if (more && consumed) page.nextCursor = encodeCursor(consumed);
  page.messages.reverse();
  return page;
}
