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

/** The same page with an extra `summary` on its user message info. */
function pageWithUserSummary(sessionId: string, summary: unknown) {
  const page = pageFor(sessionId);
  return {
    ...page,
    messages: [
      { ...page.messages[0], info: { ...page.messages[0].info, summary } },
      ...page.messages.slice(1),
    ],
  };
}

/** The same page with no caller-supplied `omittedItemCount`. */
function pageWithoutOmittedItemCount(sessionId: string, summary: unknown) {
  const { messages, nextCursor } = pageWithUserSummary(sessionId, summary);
  return { messages, nextCursor };
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

  it('parses a user summary without a diffs list by filling it with an empty list', () => {
    // Persistence stores a compaction summary without `diffs`, while the strict
    // user message schema requires the list whenever `summary` is present: one
    // such message used to degrade the whole page to `invalid_data`.
    const summary = { title: 'Compacted history' };
    const page = pageWithUserSummary('ses_12345678901234567890123456', summary);
    const parsed = persistedKiloSdkMessageHistorySchema.safeParse(page);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      messages: [{ info: { summary: { title: 'Compacted history', diffs: [] } } }, {}],
    });
    // The repair copies rather than mutates the stored page.
    expect(summary).toEqual({ title: 'Compacted history' });
  });

  it('does not count a repaired summary as an omitted item', () => {
    const supplied = persistedKiloSdkMessageHistorySchema.safeParse(
      pageWithUserSummary('ses_12345678901234567890123456', { title: 'Compacted history' })
    );
    expect(supplied.success).toBe(true);
    expect(supplied.data).toMatchObject({ omittedItemCount: 0, messages: [{}, {}] });

    const unsupplied = persistedKiloSdkMessageHistorySchema.safeParse(
      pageWithoutOmittedItemCount('ses_12345678901234567890123456', {
        title: 'Compacted history',
      })
    );
    expect(unsupplied.success).toBe(true);
    // The schema defaults the count to 0, so asserting it catches a repair that
    // starts counting the message it only touches.
    expect(unsupplied.data).toMatchObject({ omittedItemCount: 0, messages: [{}, {}] });
  });

  it('still rejects a page whose user summary is not a record', () => {
    const parsed = persistedKiloSdkMessageHistorySchema.safeParse(
      pageWithUserSummary('ses_12345678901234567890123456', 'summary')
    );
    expect(parsed.success).toBe(false);
  });

  it('still rejects a page whose summary diffs hold a malformed entry', () => {
    const parsed = persistedKiloSdkMessageHistorySchema.safeParse(
      pageWithUserSummary('ses_12345678901234567890123456', {
        title: 'Compacted history',
        diffs: [{ file: 'a.ts' }],
      })
    );
    expect(parsed.success).toBe(false);
  });
});
