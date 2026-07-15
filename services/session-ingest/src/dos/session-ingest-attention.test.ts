import { describe, it, expect } from 'vitest';
import {
  buildAssistantExcerpt,
  completedAssistantMessageIdFromItemData,
  extractTextFromPartItemData,
  isCompletedStatus,
  isNeedsInputStatus,
} from './session-ingest-attention';

function completedAssistantMessageJson(data: Record<string, unknown>): string {
  return JSON.stringify({ id: 'msg-1', ...data });
}

describe('completedAssistantMessageIdFromItemData', () => {
  it('returns the message id for a completed assistant message', () => {
    expect(
      completedAssistantMessageIdFromItemData(
        completedAssistantMessageJson({ role: 'assistant', time: { created: 1, completed: 2 } })
      )
    ).toBe('msg-1');
  });

  it('returns undefined for an assistant message without time.completed', () => {
    expect(
      completedAssistantMessageIdFromItemData(
        completedAssistantMessageJson({ role: 'assistant', time: { created: 1 } })
      )
    ).toBeUndefined();
  });

  it('returns undefined for a user message', () => {
    expect(
      completedAssistantMessageIdFromItemData(
        completedAssistantMessageJson({ role: 'user', time: { created: 1, completed: 2 } })
      )
    ).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(completedAssistantMessageIdFromItemData('{not json')).toBeUndefined();
  });
});

describe('extractTextFromPartItemData', () => {
  it('extracts text from a text part', () => {
    expect(extractTextFromPartItemData(JSON.stringify({ type: 'text', text: 'hello' }))).toBe(
      'hello'
    );
  });

  it('returns undefined for a non-text part', () => {
    expect(
      extractTextFromPartItemData(JSON.stringify({ type: 'tool', tool: 'bash' }))
    ).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(extractTextFromPartItemData('{not json')).toBeUndefined();
  });
});

describe('buildAssistantExcerpt', () => {
  it('joins multiple text parts in order and trims the result', () => {
    const rows = [
      JSON.stringify({ type: 'text', text: 'Hello ' }),
      JSON.stringify({ type: 'text', text: 'world' }),
      JSON.stringify({ type: 'text', text: '  ' }),
    ];
    expect(buildAssistantExcerpt(rows)).toBe('Hello world');
  });

  it('skips non-text parts when building the excerpt', () => {
    const rows = [
      JSON.stringify({ type: 'tool', tool: 'bash' }),
      JSON.stringify({ type: 'text', text: 'done' }),
    ];
    expect(buildAssistantExcerpt(rows)).toBe('done');
  });

  it('returns an empty string when there are no text parts', () => {
    expect(buildAssistantExcerpt([JSON.stringify({ type: 'tool', tool: 'bash' })])).toBe('');
  });

  it('collapses newlines and repeated whitespace into single spaces', () => {
    const rows = [JSON.stringify({ type: 'text', text: 'First line.\n\nSecond   line.' })];
    expect(buildAssistantExcerpt(rows)).toBe('First line. Second line.');
  });

  it('truncates a long excerpt to 100 characters with an ellipsis', () => {
    const rows = [JSON.stringify({ type: 'text', text: 'a'.repeat(250) })];
    const excerpt = buildAssistantExcerpt(rows);
    expect(excerpt).toHaveLength(100);
    expect(excerpt).toBe('a'.repeat(97) + '...');
  });

  it('keeps an excerpt at exactly 100 characters untouched', () => {
    const rows = [JSON.stringify({ type: 'text', text: 'b'.repeat(100) })];
    expect(buildAssistantExcerpt(rows)).toBe('b'.repeat(100));
  });
});

describe('isCompletedStatus', () => {
  it('returns true for idle', () => {
    expect(isCompletedStatus('idle')).toBe(true);
  });

  it('returns false for busy, question, permission, and retry', () => {
    expect(isCompletedStatus('busy')).toBe(false);
    expect(isCompletedStatus('question')).toBe(false);
    expect(isCompletedStatus('permission')).toBe(false);
    expect(isCompletedStatus('retry')).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isCompletedStatus(null)).toBe(false);
    expect(isCompletedStatus(undefined)).toBe(false);
  });
});

describe('isNeedsInputStatus', () => {
  it('returns true for question and permission', () => {
    expect(isNeedsInputStatus('question')).toBe(true);
    expect(isNeedsInputStatus('permission')).toBe(true);
  });

  it('returns false for idle, busy, and retry', () => {
    expect(isNeedsInputStatus('idle')).toBe(false);
    expect(isNeedsInputStatus('busy')).toBe(false);
    expect(isNeedsInputStatus('retry')).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isNeedsInputStatus(null)).toBe(false);
    expect(isNeedsInputStatus(undefined)).toBe(false);
  });
});
