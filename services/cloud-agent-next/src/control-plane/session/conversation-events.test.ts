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
    publish: (event: SandboxControlSessionEventInput, seed = false) =>
      persistSessionEvent({ sessionId, queries, partText, event, seed }),
  };
}

function assistantUpdate(id: string, text: string, parentID?: string, sessionID = kiloSessionId) {
  return {
    type: 'conversation.message.updated',
    properties: {
      sessionID,
      source: { ...source, session: { ...source.session, id: sessionID } },
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

it('answers with the last assistant message after a mid-turn synthetic message', async () => {
  const { queries, publish } = await fixture();
  const conversationMessage = (message: Record<string, unknown>) => ({
    type: 'conversation.message.updated',
    properties: { sessionID: kiloSessionId, source, message },
  });
  publish(
    conversationMessage({ id: userMessageId, type: 'user', time: { created: 1 }, text: 'Go' })
  );
  publish(assistantUpdate('msg_assistant_1', 'Start Docker in the background.', userMessageId));
  publish(
    conversationMessage({
      id: 'msg_synthetic',
      type: 'synthetic',
      time: { created: 2 },
      text: 'Background task finished.',
    })
  );
  publish(assistantUpdate('msg_assistant_2', 'Final answer', 'msg_synthetic'));
  publish(
    {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant_0',
          sessionID: kiloSessionId,
          role: 'assistant',
          parentID: 'msg_older_prompt',
          time: { created: 0 },
        },
      },
    },
    true
  );
  publish(
    {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_older_answer',
          messageID: 'msg_assistant_0',
          sessionID: kiloSessionId,
          type: 'text',
          text: 'Older answer from hydrated history',
        },
      },
    },
    true
  );

  const answer = { text: 'Final answer', tools: [] };
  expect(queries.getAssistantAnswerForUserMessage(sessionId, kiloSessionId, userMessageId)).toEqual(
    answer
  );
  expect(
    queries.getRecentAssistantAnswersForUserMessage(sessionId, kiloSessionId, userMessageId)
  ).toEqual([{ text: 'Start Docker in the background.', tools: [] }, answer]);
});

it('fills recent activity past removed messages from legacy history', async () => {
  const { queries, publish } = await fixture();
  for (let index = 1; index <= 7; index++) {
    const messageID = `msg_assistant_${index}`;
    publish({
      type: 'message.updated',
      timestamp: new Date(2).toISOString(),
      properties: {
        info: {
          id: messageID,
          role: 'assistant',
          sessionID: kiloSessionId,
          parentID: userMessageId,
          time: { created: 1 },
        },
      },
    });
    publish({
      type: 'message.part.updated',
      properties: {
        part: {
          id: `prt_${index}`,
          messageID,
          sessionID: kiloSessionId,
          type: 'text',
          text: `${index}`,
        },
      },
    });
  }
  for (const index of [3, 6, 7]) {
    queries.insert({
      sessionId,
      executionId: '',
      streamEventType: 'kilocode',
      payload: JSON.stringify({
        event: 'message.removed',
        properties: { sessionID: kiloSessionId, messageID: `msg_assistant_${index}` },
      }),
      timestamp: index === 3 ? 1 : 2,
    });
  }
  expect(
    queries.getRecentAssistantAnswersForUserMessage(sessionId, kiloSessionId, userMessageId)
  ).toEqual(['1', '2', '3', '4', '5'].map(text => ({ text, tools: [] })));
});

it('does not inherit a callback parent from another Kilo session', async () => {
  const { queries, publish } = await fixture();
  const entityId = 'message/msg_assistant_2';
  publish(assistantUpdate('msg_assistant_2', 'Other answer', userMessageId, 'ses_other'));
  expect(JSON.parse(queries.findByEntityId(entityId)?.payload ?? 'null')).toMatchObject({
    properties: { sessionID: 'ses_other', parentID: userMessageId },
  });

  publish(assistantUpdate('msg_assistant_2', 'Unattributed answer'));
  const stored = JSON.parse(queries.findByEntityId(entityId)?.payload ?? 'null');
  expect(stored).toMatchObject({ properties: { sessionID: kiloSessionId } });
  expect(stored.properties).not.toHaveProperty('parentID');
  expect(
    queries.getAssistantAnswerForUserMessage(sessionId, kiloSessionId, userMessageId)
  ).toBeNull();
});
