import { describe, expect, it } from 'vitest';
import {
  createAssistantMessage,
  createEvalToolCall,
  createToolResult,
  createUserMessage,
} from './agent-conversation';
import {
  KEEP_RECENT_EXCHANGES,
  KEEP_RECENT_EXCHANGES_MANUAL,
  SUMMARY_PREFIX,
  hasCompactableHistory,
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

  it('summarizes the whole conversation at the manual threshold (keep 0)', () => {
    const events = [
      createAssistantMessage('greeting'),
      createUserMessage('one'),
      createAssistantMessage('a1'),
    ];

    // A single exchange has nothing to summarize at the auto threshold, but manual compacts it all.
    expect(hasCompactableHistory(events)).toBe(false);
    expect(hasCompactableHistory(events, KEEP_RECENT_EXCHANGES_MANUAL)).toBe(true);

    const { toKeep, toSummarize } = splitEventsForCompaction(events, KEEP_RECENT_EXCHANGES_MANUAL);
    expect(toKeep).toStrictEqual([]);
    expect(toSummarize).toStrictEqual(events);
  });

  it('has nothing to compact without a user message', () => {
    const events = [createAssistantMessage('greeting')];
    expect(hasCompactableHistory(events, KEEP_RECENT_EXCHANGES_MANUAL)).toBe(false);
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

  it('preserves tool inputs and result payloads', () => {
    const text = renderEventsAsTranscript([
      createEvalToolCall({ code: 'return document.title;', tabId: 1 }),
      createToolResult({ ok: true, toolCallId: 'call-1', value: 'Example Domain' }),
      createToolResult({ error: 'boom', ok: false, toolCallId: 'call-2' }),
    ]);
    expect(text).toContain('Tool call (eval): return document.title;');
    expect(text).toContain('Tool result (ok): Example Domain');
    expect(text).toContain('Tool result (error): boom');
  });

  it('omits screenshot data URLs instead of dumping base64 into the transcript', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(5000)}`;
    const text = renderEventsAsTranscript([
      createToolResult({
        ok: true,
        toolCallId: 'call-1',
        value: { dataUrl, mediaType: 'image/png' },
      }),
    ]);
    expect(text).toContain('[image/png screenshot omitted]');
    expect(text).not.toContain('AAAA');
  });

  it('omits persisted screenshot stubs instead of dumping their JSON into the transcript', () => {
    const text = renderEventsAsTranscript([
      createToolResult({
        ok: true,
        toolCallId: 'call-1',
        value: {
          mediaType: 'image/png',
          note: 'Viewport screenshot omitted from persisted history.',
        },
      }),
    ]);
    expect(text).toContain('[image/png screenshot omitted]');
    expect(text).not.toContain('note');
  });

  it('truncates oversized tool result payloads', () => {
    const text = renderEventsAsTranscript([
      createToolResult({ ok: true, toolCallId: 'call-1', value: 'x'.repeat(5000) }),
    ]);
    expect(text).toContain('[truncated 3000 chars]');
    expect(text.length).toBeLessThan(3000);
  });
});

describe('tuning constants', () => {
  it('exposes tuning constants', () => {
    expect(KEEP_RECENT_EXCHANGES).toBe(2);
    expect(KEEP_RECENT_EXCHANGES_MANUAL).toBe(0);
    expect(SUMMARY_PREFIX.length).toBeGreaterThan(0);
  });
});
