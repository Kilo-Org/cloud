import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import type { SandboxControlSessionEventInput } from '../../sandbox-session/sandbox-control-event.js';
import migrations from './drizzle/migrations.js';
import { createSessionEventQueries } from './event-queries.js';
import { persistSessionEvent } from './native-events.js';
import { createPartTextBuffer } from './part-text-buffer.js';

const sessionId = 'workspace_child';
const kiloSessionId = 'ses_child';
const userMessageId = 'msg_prompt';
const source = {
  version: 'v2',
  session: {
    id: kiloSessionId,
    location: { directory: '/workspace/app' },
    time: { created: 1, updated: 2 },
  },
};

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  onTestFinished(() => sqlite.close());
  const storage = {
    sql: {
      exec(query: string, ...params: SQLInputValue[]) {
        const statement = sqlite.prepare(query);
        const columns = statement.columns();
        const rows = statement.all(...params);
        return {
          toArray: () => rows,
          raw: () => ({ toArray: () => rows.map(row => columns.map(column => row[column.name])) }),
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync<T>(action: () => T): T {
      sqlite.exec('BEGIN');
      try {
        const result = action();
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  const db = drizzle(storage);
  await migrate(db, migrations);
  const queries = createSessionEventQueries(db, storage);
  const partText = createPartTextBuffer({
    queries,
    onFlushError: error => {
      throw error;
    },
  });
  return {
    queries,
    publish: (event: SandboxControlSessionEventInput) =>
      persistSessionEvent({ sessionId, queries, partText, event }),
  };
}

function assistantUpdate(id: string, text: string, parentID?: string) {
  return {
    type: 'conversation.message.updated',
    properties: {
      sessionID: kiloSessionId,
      source,
      message: {
        id,
        type: 'assistant',
        time: { created: 2, completed: 3 },
        content: [{ type: 'text', text }],
      },
      ...(parentID === undefined ? {} : { parentID }),
    },
  };
}

it.each([
  { update: 'omitted', parentID: undefined },
  { update: 'empty', parentID: '' },
])('keeps the final callback answer when parentID is $update', async ({ parentID }) => {
  const { queries, publish } = await fixture();
  publish(assistantUpdate('msg_assistant_1', 'Earlier activity', userMessageId));
  const initial = publish(assistantUpdate('msg_assistant_2', '', userMessageId));
  const updated = publish(assistantUpdate('msg_assistant_2', 'Final answer', parentID));

  const row = queries.findByEntityId('message/msg_assistant_2');
  expect(updated?.id).toBe(initial?.id);
  expect(JSON.parse(row?.payload ?? 'null')).toMatchObject({
    properties: { parentID: userMessageId },
  });
  const answer = { text: 'Final answer', tools: [] };
  expect(queries.getAssistantAnswerForUserMessage(sessionId, kiloSessionId, userMessageId)).toEqual(
    answer
  );
  expect(
    queries.getRecentAssistantAnswersForUserMessage(sessionId, kiloSessionId, userMessageId)
  ).toEqual([{ text: 'Earlier activity', tools: [] }, answer]);
});

it('excludes removed native v2 answers from recent callback activity', async () => {
  const { queries, publish } = await fixture();
  publish(assistantUpdate('msg_retained', 'Current answer', userMessageId));
  const removed = publish(assistantUpdate('msg_removed', 'Removed answer', userMessageId));
  if (!removed) throw new Error('Expected a persisted assistant message');

  for (const [messageID, removalSessionId] of [
    ['msg_removed', kiloSessionId],
    ['msg_retained', 'ses_unrelated'],
  ]) {
    queries.insert({
      sessionId,
      executionId: '',
      streamEventType: 'kilocode',
      payload: JSON.stringify({
        event: 'message.removed',
        properties: { messageID, sessionID: removalSessionId },
      }),
      timestamp: removed.timestamp + 1,
    });
  }

  expect(
    queries.getRecentAssistantAnswersForUserMessage(sessionId, kiloSessionId, userMessageId)
  ).toEqual([{ text: 'Current answer', tools: [] }]);
});
