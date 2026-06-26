import { describe, expect, it } from 'vitest';
import { createAssistantMessage, createUserMessage } from './agent-conversation';
import {
  KEEP_RECENT_EXCHANGES,
  SUMMARY_PREFIX,
  renderEventsAsTranscript,
  splitEventsForCompaction,
} from './agent-context-compaction';

describe('split events for compaction', () => {
  it('keeps the last N exchanges and summarizes the rest', () => {
    const events = [
      createAssistantMessage('greeting'),
      createUserMessage('one'),
      createAssistantMessage('a1'),
      createUserMessage('two'),
      createAssistantMessage('a2'),
      createUserMessage('three'),
      createAssistantMessage('a3'),
    ];

    const { toKeep, toSummarize } = splitEventsForCompaction(events);

    // KEEP_RECENT_EXCHANGES = 2 → keep from the 2nd-to-last user message ('two')
    expect(toKeep[0]).toMatchObject({ role: 'user', text: 'two' });
    expect(toKeep.at(-1)).toMatchObject({ text: 'a3' });
    expect(toSummarize).toMatchObject([{ text: 'greeting' }, { text: 'one' }, { text: 'a1' }]);
  });

  it('summarizes nothing when there are too few user messages', () => {
    const events = [createAssistantMessage('greeting'), createUserMessage('one')];
    const { toKeep, toSummarize } = splitEventsForCompaction(events);
    expect(toSummarize).toStrictEqual([]);
    expect(toKeep).toStrictEqual(events);
  });
});

describe('render events as transcript', () => {
  it('renders user and assistant lines', () => {
    const text = renderEventsAsTranscript([
      createUserMessage('hello'),
      createAssistantMessage('hi there'),
    ]);
    expect(text).toContain('User: hello');
    expect(text).toContain('Assistant: hi there');
  });
});

describe('tuning constants', () => {
  it('exposes tuning constants', () => {
    expect(KEEP_RECENT_EXCHANGES).toBe(2);
    expect(SUMMARY_PREFIX.length).toBeGreaterThan(0);
  });
});
