import { expect, it } from 'vitest';
import type { SessionEventQueries } from './event-queries.js';
import { MAX_TOOL_DETAIL_BYTES, readToolPartDetail } from './tool-detail.js';

it('accepts native details that fit after projecting sibling tools in a larger stored message', () => {
  const sessionId = 'workspace_11111111-1111-4111-8111-111111111111';
  const kiloSessionId = 'ses_12345678901234567890123456';
  const source = {
    version: 'v2',
    session: {
      id: kiloSessionId,
      location: { directory: '/workspace/app' },
      time: { created: 1, updated: 2 },
    },
  };
  const tool = (id: string, text: string) => ({
    type: 'tool',
    id,
    name: 'shell',
    state: {
      status: 'completed',
      input: { command: 'cat file' },
      content: [{ type: 'text', text }],
    },
    time: { created: 1, completed: 2 },
  });
  const payload = JSON.stringify({
    type: 'conversation.message.updated',
    event: 'conversation.message.updated',
    properties: {
      sessionID: kiloSessionId,
      source,
      message: {
        id: 'msg_tools',
        type: 'assistant',
        time: { created: 1 },
        content: [
          { type: 'text', text: 'a'.repeat(3_900_000) },
          tool('call_sibling', 'b'.repeat(450_000)),
          tool('call_requested', 'complete output'),
        ],
      },
    },
  });
  const queries = {
    findByEntityId: (entityId: string) => ({
      session_id: sessionId,
      mutation_cursor: 7,
      payload: entityId.startsWith('conversation-source/')
        ? JSON.stringify({ properties: { source } })
        : payload,
    }),
  } as SessionEventQueries;

  expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(MAX_TOOL_DETAIL_BYTES);
  const detail = readToolPartDetail({
    queries,
    sessionId,
    kiloSessionId,
    messageId: 'msg_tools',
    partId: 'unused',
    callId: 'call_requested',
  });
  expect(detail.kind).toBe('found');
  expect(new TextEncoder().encode(JSON.stringify(detail)).byteLength).toBeLessThan(
    MAX_TOOL_DETAIL_BYTES
  );
  expect(detail).toMatchObject({
    kind: 'found',
    message: {
      content: [
        { type: 'text' },
        { id: 'call_sibling', cloudDetail: { revision: 7 } },
        tool('call_requested', 'complete output'),
      ],
    },
  });
});
