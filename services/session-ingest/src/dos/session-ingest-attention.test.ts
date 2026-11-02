import { describe, it, expect } from 'vitest';
import {
  assistantExcerptIsComplete,
  attentionKindForNeedsInputStatus,
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
  it('joins multiple text pieces in order and trims the result', () => {
    expect(buildAssistantExcerpt(['Hello ', 'world', '  '])).toBe('Hello world');
  });

  it('returns an empty string when there are no text pieces', () => {
    expect(buildAssistantExcerpt([])).toBe('');
    expect(buildAssistantExcerpt([''])).toBe('');
  });

  it('collapses newlines and repeated whitespace into single spaces', () => {
    expect(buildAssistantExcerpt(['First line.\n\nSecond   line.'])).toBe(
      'First line. Second line.'
    );
  });

  it('truncates a long excerpt to 100 characters with an ellipsis', () => {
    const excerpt = buildAssistantExcerpt(['a'.repeat(250)]);
    expect(excerpt).toHaveLength(100);
    expect(excerpt).toBe('a'.repeat(97) + '...');
  });

  it('keeps an excerpt at exactly 100 characters untouched', () => {
    expect(buildAssistantExcerpt(['b'.repeat(100)])).toBe('b'.repeat(100));
  });
});

describe('assistantExcerptIsComplete', () => {
  it('marks exactly the point where later text cannot change the excerpt', () => {
    const filled = 'a'.repeat(100);
    // A prefix at the excerpt length is not settled: one more character turns the untrimmed text
    // into the truncated form with an ellipsis.
    expect(assistantExcerptIsComplete(filled)).toBe(false);
    expect(buildAssistantExcerpt([filled, 'b'])).toBe(buildAssistantExcerpt([`${filled}b`]));

    const past = `${filled}b`;
    expect(assistantExcerptIsComplete(past)).toBe(true);
    expect(buildAssistantExcerpt([past])).toBe(buildAssistantExcerpt([`${past}c`]));
    expect(buildAssistantExcerpt([past])).toBe('a'.repeat(97) + '...');
  });

  it('counts collapsed characters, not raw ones, so whitespace alone never completes it', () => {
    expect(assistantExcerptIsComplete(' '.repeat(500))).toBe(false);
    expect(assistantExcerptIsComplete(`${'a'.repeat(101)}${'\n'.repeat(500)}`)).toBe(true);
    expect(assistantExcerptIsComplete(`  ${'a'.repeat(101)}\n\n`)).toBe(true);
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

describe('attentionKindForNeedsInputStatus', () => {
  it('maps a question status to the question kind', () => {
    expect(attentionKindForNeedsInputStatus('question')).toBe('question');
  });

  it('maps a permission status to the permission kind', () => {
    expect(attentionKindForNeedsInputStatus('permission')).toBe('permission');
  });

  it('falls back to permission for an unrecognized status', () => {
    expect(attentionKindForNeedsInputStatus('busy')).toBe('permission');
    expect(attentionKindForNeedsInputStatus(null)).toBe('permission');
    expect(attentionKindForNeedsInputStatus(undefined)).toBe('permission');
  });
});
