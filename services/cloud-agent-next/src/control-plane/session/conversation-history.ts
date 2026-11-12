import { and, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
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
  MAX_SESSION_PREVIEW_PAGE_BYTES,
  type readSessionMessagesPage,
  type HistoryCursor,
} from './history.js';
import { isKilocodeRow } from './event-queries.js';
import { events } from './sqlite-schema.js';
import { projectKilo2MessageForDisplay } from '../../shared/tool-display-projection.js';

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

export function readConversationSource(input: Pick<Input, 'queries' | 'kiloSessionId'>) {
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
  // Keep the read on the message entity range, as the v1 history reader does.
  const scope = and(
    eq(events.session_id, sessionId),
    isKilocodeRow,
    gte(events.entity_id, 'message/'),
    lt(events.entity_id, 'message0'),
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
  const preview = input.toolDisplay === 'preview';
  const softBudget = preview ? MAX_SESSION_PREVIEW_PAGE_BYTES : MAX_SESSION_PAGE_BYTES;
  // Reserve the maximum cursor before accepting a native message. Read payloads
  // only after checking their stored size, as in the v1 history reader.
  let bytes = size({ ...page, nextCursor: 'x'.repeat(2048) });
  const limit = input.limit ?? 50;
  const rows = db
    .select({
      id: events.id,
      createdAt,
      messageId,
      revision: events.mutation_cursor,
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
    // A stored row above the budget is read only when its projection may fit.
    const read = () =>
      db.select({ payload: events.payload }).from(events).where(eq(events.id, row.id)).get();
    let stored = !preview || bytes + row.bytes <= softBudget ? undefined : read();
    let parsed = stored === undefined ? undefined : parseMessage(stored.payload, preview, row);
    const rowBytes = parsed?.success ? size(displayItem(parsed.data.properties)) : row.bytes;
    if (page.messages.length && bytes + rowBytes > softBudget) {
      more = true;
      break;
    }
    consumed = key;
    if (bytes + rowBytes > MAX_SESSION_PAGE_BYTES) {
      page.omittedItemCount++;
      continue;
    }
    stored ??= read();
    parsed ??= stored ? parseMessage(stored.payload, preview, row) : undefined;
    if (
      !parsed?.success ||
      parsed.data.properties.sessionID !== kiloSessionId ||
      parsed.data.properties.message.id !== row.messageId
    ) {
      page.omittedItemCount++;
      continue;
    }
    const item = displayItem(parsed.data.properties);
    page.messages.push(item);
    bytes += size(item) + 1;
  }
  if (more && consumed) page.nextCursor = encodeCursor(consumed);
  page.messages.reverse();
  return page;
}

const storedMessageSchema = z.object({ properties: kilo2ConversationMessageSchema });

function parseMessage(
  payload: string,
  preview: boolean,
  row: { revision: number | null | undefined }
) {
  const parsed = storedMessageSchema.safeParse(JSON.parse(payload));
  if (!parsed.success || !preview || row.revision == null) return parsed;
  const properties = parsed.data.properties;
  return {
    ...parsed,
    data: {
      properties: {
        ...properties,
        message: projectKilo2MessageForDisplay(properties.message, row.revision) as Kilo2Message,
      },
    },
  };
}

function displayItem(properties: z.infer<typeof kilo2ConversationMessageSchema>) {
  return {
    message: properties.message,
    ...(properties.parentID ? { parentID: properties.parentID } : {}),
  };
}
