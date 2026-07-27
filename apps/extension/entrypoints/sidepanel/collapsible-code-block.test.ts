import { describe, expect, it } from 'vitest';
import {
  COLLAPSE_LINE_THRESHOLD,
  COLLAPSE_PREVIEW_LINES,
  countCodeLines,
  isCollapsible,
  previewCode,
  resolveCodeBlockChrome,
} from './collapsible-code-block';

const lines = (count: number, ending = '\n'): string =>
  Array.from({ length: count }, (_unused, index) => `line-${index + 1}`).join('\n') + ending;

describe('countCodeLines helper', () => {
  it('returns 0 for the empty string', () => {
    expect(countCodeLines('')).toBe(0);
  });

  it('returns 0 for a lone trailing newline', () => {
    expect(countCodeLines('\n')).toBe(0);
  });

  it('does not count a single trailing newline as a phantom empty line', () => {
    expect(countCodeLines('a\n')).toBe(1);
    expect(countCodeLines('a\nb\n')).toBe(2);
  });

  it('counts content without a trailing newline', () => {
    expect(countCodeLines('a')).toBe(1);
    expect(countCodeLines('a\nb')).toBe(2);
  });

  it('handles CRLF and bare CR', () => {
    expect(countCodeLines('a\r\nb\r\n')).toBe(2);
    expect(countCodeLines('a\rb\r')).toBe(2);
    expect(countCodeLines('a\r\nb\rc\n')).toBe(3);
  });

  it('counts a real empty line before a trailing newline', () => {
    expect(countCodeLines('a\n\n')).toBe(2);
  });
});

describe('isCollapsible helper', () => {
  it(`is false at the threshold (${COLLAPSE_LINE_THRESHOLD} lines)`, () => {
    expect(isCollapsible(lines(COLLAPSE_LINE_THRESHOLD))).toBe(false);
    expect(isCollapsible(lines(COLLAPSE_LINE_THRESHOLD, ''))).toBe(false);
  });

  it(`is true above the threshold (${COLLAPSE_LINE_THRESHOLD + 1} lines)`, () => {
    expect(isCollapsible(lines(COLLAPSE_LINE_THRESHOLD + 1))).toBe(true);
    expect(isCollapsible(lines(COLLAPSE_LINE_THRESHOLD + 1, ''))).toBe(true);
  });

  it('is false for short and empty blocks', () => {
    expect(isCollapsible('')).toBe(false);
    expect(isCollapsible(lines(1))).toBe(false);
  });
});

describe('previewCode helper', () => {
  it(`returns the first ${COLLAPSE_PREVIEW_LINES} lines`, () => {
    const code = lines(20);
    const preview = previewCode(code);
    expect(preview.split('\n')).toHaveLength(COLLAPSE_PREVIEW_LINES);
    expect(preview).toBe(lines(COLLAPSE_PREVIEW_LINES, ''));
  });

  it('returns the full short block when under the preview length', () => {
    expect(previewCode('a\nb')).toBe('a\nb');
    expect(previewCode('a\nb\n')).toBe('a\nb');
  });

  it('returns empty for empty input', () => {
    expect(previewCode('')).toBe('');
  });
});

describe('resolveCodeBlockChrome helper', () => {
  it('returns plain when not collapsible regardless of forceExpanded', () => {
    expect(resolveCodeBlockChrome({ collapsible: false, forceExpanded: false })).toBe('plain');
    expect(resolveCodeBlockChrome({ collapsible: false, forceExpanded: true })).toBe('plain');
  });

  it('returns expanded-no-chrome when collapsible and forceExpanded (this message streaming)', () => {
    expect(resolveCodeBlockChrome({ collapsible: true, forceExpanded: true })).toBe(
      'expanded-no-chrome'
    );
  });

  it('returns collapsible when collapsible and not forceExpanded (finalized long block)', () => {
    expect(resolveCodeBlockChrome({ collapsible: true, forceExpanded: false })).toBe('collapsible');
  });

  it('treats a streaming id for a previous message as forceExpanded false on the current message', () => {
    // MessageEvent computes forceExpanded as event.id === streamingMessageId.
    // When streamingMessageId points at a previous message, the current message
    // Receives forceExpanded: false and a long block must still collapse.
    const currentMessageForceExpanded = false;
    expect(
      resolveCodeBlockChrome({
        collapsible: true,
        forceExpanded: currentMessageForceExpanded,
      })
    ).toBe('collapsible');
  });
});
