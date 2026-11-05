import { persistedKiloSdkMessageHistorySchema } from '@kilocode/session-ingest-contracts';
import { describe, expect, it } from 'vitest';

/**
 * A stored page as the message page route returns it, built around one session
 * id. The user message, the assistant message and the text part all carry the
 * id the session was created with.
 */
function pageFor(sessionId: string) {
  return {
    messages: [
      {
        info: {
          id: 'msg_1',
          sessionID: sessionId,
          role: 'user',
          time: { created: 1_790_000_000_000 },
          agent: 'build',
          model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
        },
        parts: [
          {
            id: 'prt_1',
            sessionID: sessionId,
            messageID: 'msg_1',
            type: 'text',
            text: 'Keep the dark surface across a restart.',
          },
        ],
      },
      {
        info: {
          id: 'msg_2',
          sessionID: sessionId,
          role: 'assistant',
          time: { created: 1_790_000_004_000, completed: 1_790_000_005_000 },
          parentID: 'msg_1',
          providerID: 'kilo',
          modelID: 'kilo-auto/efficient',
          mode: 'build',
          agent: 'build',
          path: { cwd: '/workspace/repo', root: '/workspace/repo' },
          cost: 0.01,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: 'prt_2',
            sessionID: sessionId,
            messageID: 'msg_2',
            type: 'text',
            text: 'Pinned the surface theme before the root renders.',
          },
        ],
      },
    ],
    nextCursor: null,
    omittedItemCount: 0,
  };
}

describe('persisted message history for a stored session id', () => {
  it('parses a page whose messages and parts carry an id minted before the canonical shape', () => {
    // The store keeps sessions created before `ses_` + 26 was the only issued
    // shape. Their transcript is served by the same page read, so the page's
    // own session id has to parse: rejecting it turned the whole page into
    // `invalid_data` and left the session with no transcript at all.
    const parsed = persistedKiloSdkMessageHistorySchema.safeParse(pageFor('xmw2l780h18'));
    expect(parsed.success).toBe(true);
  });

  it('still parses a canonical page', () => {
    const parsed = persistedKiloSdkMessageHistorySchema.safeParse(
      pageFor('ses_12345678901234567890123456')
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a page whose stored messages name an id no route segment can carry', () => {
    expect(persistedKiloSdkMessageHistorySchema.safeParse(pageFor('ses_123/456')).success).toBe(
      false
    );
  });
});
