import { type MessageInfo, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { parseTimestamp } from '@/lib/utils';

/**
 * The stored quick-chat row contract, matching `listMessages` / `appendMessages`
 * serialization from `apps/web/src/routers/quick-chat-router.ts`.
 */
export type QuickChatMessageRole = 'user' | 'assistant';

export type QuickChatRow = {
  id: string;
  role: QuickChatMessageRole;
  content: string;
  createdAt: string;
  clientId?: string | null;
};

/**
 * One locally-accepted turn that may not be visible to a `listMessages` yet:
 * the user message plus (once streaming starts) its assistant reply.
 */
export type LocalTurn = {
  clientId: string;
  rows: QuickChatRow[];
};

/**
 * Adapt a stored row into the `StoredMessage` shape `MessageBubble` renders.
 * The row carries only `{ id, role, content, createdAt }`; the remaining
 * `MessageInfo` fields are filled with neutral values because quick-chat has
 * no session tooling, model tracking, or cost accounting on the client.
 */
export function adaptQuickChatRow(row: QuickChatRow, threadId: string): StoredMessage {
  const created = parseTimestamp(row.createdAt).getTime();
  const info: MessageInfo =
    row.role === 'user'
      ? {
          id: row.id,
          sessionID: threadId,
          role: 'user',
          time: { created },
          agent: 'quick-chat',
          model: { providerID: 'kilo', modelID: '' },
        }
      : {
          id: row.id,
          sessionID: threadId,
          role: 'assistant',
          time: { created },
          parentID: '',
          modelID: '',
          providerID: 'kilo',
          mode: 'ask',
          agent: 'quick-chat',
          path: { cwd: '', root: '' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        };
  return {
    info,
    parts: [
      {
        id: `${row.id}:text`,
        sessionID: threadId,
        messageID: row.id,
        type: 'text',
        text: row.content,
      },
    ],
  };
}

/**
 * Union the persisted rows with local turns so a late `listMessages` cannot
 * drop a sent turn. A local turn is dropped only once the server has returned
 * the user message bearing its `clientId` (the append persists the whole turn,
 * so the assistant reply is present too).
 */
export function mergeQuickChatRows(
  serverRows: readonly QuickChatRow[],
  localTurns: readonly LocalTurn[]
): QuickChatRow[] {
  const persistedClientIds = new Set<string>();
  for (const row of serverRows) {
    if (row.clientId) {
      persistedClientIds.add(row.clientId);
    }
  }
  const pending = localTurns
    .filter(turn => !persistedClientIds.has(turn.clientId))
    .flatMap(turn => turn.rows);
  return [...serverRows, ...pending];
}
