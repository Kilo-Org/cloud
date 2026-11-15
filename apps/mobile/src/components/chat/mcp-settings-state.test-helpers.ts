import { Effect } from 'effect';

import { type Tool } from '@kilocode/harness-sdk';

import { type ChatFlag } from '@/lib/chat/chat-flag';

/**
 * The values the MCP settings view suite builds its world from: a tool the
 * server offered, and the chat's flag for a choice that is on disk. Shared with
 * `mcp-settings-state.test.ts` so each case names only the field it is about.
 */

export const tool = (name: string): Tool => ({
  definition: {
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
  },
  run: () => Effect.succeed(''),
});

/** The chat's flag for a choice that is on disk, on this session unless said otherwise. */
export const saved = (
  choice: boolean | null,
  application: 'current' | 'moving' | 'behind' = 'current'
): ChatFlag => ({ kind: 'saved', choice, application });
