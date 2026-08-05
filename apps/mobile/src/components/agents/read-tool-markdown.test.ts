/* eslint-disable max-lines -- cohesive unit suite for read-tool-markdown pure functions */
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  balanceCodeFences,
  isMarkdownPath,
  parseReadFileDisplay,
  parseReadOutputFallback,
  resolveMarkdownBody,
} from './read-tool-markdown';

// F1 complete 3-line read (note the trailing space on line 2)
const COMPLETE =
  '<path>/repo/README.md</path>\n<type>file</type>\n<content>\n' +
  '1: # Title\n2: \n3: - item\n\n(End of file - total 3 lines)\n</content>';

// F2 windowed read
const WINDOWED =
  '<path>/repo/BIG.md</path>\n<type>file</type>\n<content>\n' +
  '201: ## Middle\n202: text\n\n(Showing lines 201-202 of 1450. Use offset=203 to continue.)\n</content>';

// F3 byte-capped read (no total available)
const CAPPED =
  '<path>/repo/BIG.md</path>\n<type>file</type>\n<content>\n' +
  '1: a\n2: b\n\n(Output capped at 50.0KB. Showing lines 1-2. Use offset=3 to continue.)\n</content>';

// F4 empty file
const EMPTY =
  '<path>/repo/EMPTY.md</path>\n<type>file</type>\n<content>\n' +
  '\n\n(End of file - total 0 lines)\n</content>';

// F5 complete read followed by a system-reminder block
const WITH_REMINDER = `${COMPLETE}\n\n<system-reminder>\nbe careful\n</system-reminder>`;

// F6 a content line that itself contains ": "
const COLON_IN_TEXT =
  '<path>/repo/N.md</path>\n<type>file</type>\n<content>\n' +
  '1: key: value\n\n(End of file - total 1 lines)\n</content>';

function makeCompletedPart(overrides: {
  filePath?: string;
  output?: string;
  metadata?: Record<string, unknown>;
}): ToolPart {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: overrides.filePath ?? '/repo/README.md' },
      output: overrides.output ?? '',
      title: 'read',
      metadata: overrides.metadata ?? {},
      time: { start: 0, end: 1 },
    },
  };
}

describe('isMarkdownPath', () => {
  it('accepts .md and .mdx case-insensitively', () => {
    expect(isMarkdownPath('a.md')).toBe(true);
    expect(isMarkdownPath('a.mdx')).toBe(true);
    expect(isMarkdownPath('A.MD')).toBe(true);
  });

  it('rejects non-markdown paths', () => {
    expect(isMarkdownPath('a.ts')).toBe(false);
    expect(isMarkdownPath('a.markdown')).toBe(false);
    expect(isMarkdownPath('md')).toBe(false);
    expect(isMarkdownPath('')).toBe(false);
  });
});

describe('parseReadFileDisplay', () => {
  const validDisplay = {
    type: 'file',
    path: '/repo/README.md',
    text: '# Title',
    lineStart: 1,
    lineEnd: 1,
    totalLines: 1,
  };

  it('parses a valid file display', () => {
    expect(parseReadFileDisplay({ display: validDisplay })).toEqual({
      path: '/repo/README.md',
      text: '# Title',
      lineStart: 1,
      lineEnd: 1,
      totalLines: 1,
      truncated: false,
    });
  });

  it('returns undefined when text is missing', () => {
    const { text: _text, ...rest } = validDisplay;
    expect(parseReadFileDisplay({ display: rest })).toBeUndefined();
  });

  it('returns undefined for directory display', () => {
    expect(
      parseReadFileDisplay({
        display: { ...validDisplay, type: 'directory' },
      })
    ).toBeUndefined();
  });

  it('returns undefined when totalLines is non-numeric', () => {
    expect(
      parseReadFileDisplay({
        display: { ...validDisplay, totalLines: '3' },
      })
    ).toBeUndefined();
  });

  it('returns undefined for non-object metadata', () => {
    expect(parseReadFileDisplay(undefined)).toBeUndefined();
    expect(parseReadFileDisplay(null)).toBeUndefined();
    expect(parseReadFileDisplay('string')).toBeUndefined();
  });

  it('defaults truncated to false unless exactly true', () => {
    expect(parseReadFileDisplay({ display: validDisplay })?.truncated).toBe(false);
    expect(parseReadFileDisplay({ display: { ...validDisplay, truncated: true } })?.truncated).toBe(
      true
    );
    expect(
      parseReadFileDisplay({ display: { ...validDisplay, truncated: false } })?.truncated
    ).toBe(false);
  });
});

describe('parseReadOutputFallback', () => {
  it('parses a complete 3-line read including a blank line', () => {
    expect(parseReadOutputFallback(COMPLETE)).toEqual({
      path: '/repo/README.md',
      text: '# Title\n\n- item',
      lineStart: 1,
      lineEnd: 3,
      totalLines: 3,
      truncated: false,
    });
  });

  it('parses a windowed read', () => {
    expect(parseReadOutputFallback(WINDOWED)).toEqual({
      path: '/repo/BIG.md',
      text: '## Middle\ntext',
      lineStart: 201,
      lineEnd: 202,
      totalLines: 1450,
      truncated: true,
    });
  });

  it('parses a byte-capped read with totalLines === lineEnd', () => {
    const result = parseReadOutputFallback(CAPPED);
    expect(result).toMatchObject({
      path: '/repo/BIG.md',
      text: 'a\nb',
      lineStart: 1,
      lineEnd: 2,
      truncated: true,
    });
    expect(result?.totalLines).toBe(result?.lineEnd);
  });

  it('strips a trailing system-reminder block', () => {
    const result = parseReadOutputFallback(WITH_REMINDER);
    expect(result?.text).toBe('# Title\n\n- item');
    expect(result?.text).not.toContain('system-reminder');
    expect(result?.text).not.toContain('be careful');
  });

  it('parses an empty file', () => {
    expect(parseReadOutputFallback(EMPTY)).toEqual({
      path: '/repo/EMPTY.md',
      text: '',
      lineStart: 1,
      lineEnd: 0,
      totalLines: 0,
      truncated: false,
    });
  });

  it('strips the line prefix exactly once when content contains ": "', () => {
    expect(parseReadOutputFallback(COLON_IN_TEXT)).toEqual({
      path: '/repo/N.md',
      text: 'key: value',
      lineStart: 1,
      lineEnd: 1,
      totalLines: 1,
      truncated: false,
    });
  });

  it('returns undefined without a <content> marker', () => {
    expect(parseReadOutputFallback('no content here')).toBeUndefined();
  });

  it('returns undefined when the first body line lacks an N: prefix', () => {
    const bad =
      '<path>/repo/X.md</path>\n<type>file</type>\n<content>\n' +
      'not numbered\n\n(End of file - total 1 lines)\n</content>';
    expect(parseReadOutputFallback(bad)).toBeUndefined();
  });
});

describe('balanceCodeFences', () => {
  it('leaves even fence counts unchanged', () => {
    const text = '```ts\nconst x = 1;\n```';
    expect(balanceCodeFences(text)).toBe(text);
  });

  it('appends a closing fence when the count is odd', () => {
    const text = '```ts\nconst x = 1;';
    expect(balanceCodeFences(text)).toBe('```ts\nconst x = 1;\n```');
  });

  it('leaves zero fences unchanged', () => {
    expect(balanceCodeFences('plain')).toBe('plain');
  });

  it('counts indented fences', () => {
    const text = '  ```\ncode';
    expect(balanceCodeFences(text)).toBe('  ```\ncode\n```');
  });
});

describe('resolveMarkdownBody', () => {
  it('prefers display text over output when both exist', () => {
    const part = makeCompletedPart({
      output: COMPLETE,
      metadata: {
        display: {
          type: 'file',
          path: '/repo/README.md',
          text: '# From display',
          lineStart: 1,
          lineEnd: 1,
          totalLines: 1,
        },
      },
    });
    const body = resolveMarkdownBody(part);
    expect(body?.text).toBe('# From display');
    expect(body?.text).not.toMatch(/^\d+: /m);
    expect(body?.text).not.toContain('1: ');
  });

  it('falls back to output when display.text is absent', () => {
    const part = makeCompletedPart({
      output: COMPLETE,
      metadata: {},
    });
    const body = resolveMarkdownBody(part);
    expect(body?.text).toBe('# Title\n\n- item');
  });

  it('returns undefined for a non-completed state', () => {
    const part: ToolPart = {
      id: 'part-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'read',
      state: {
        status: 'running',
        input: { filePath: '/repo/README.md' },
        time: { start: 0 },
      },
    };
    expect(resolveMarkdownBody(part)).toBeUndefined();
  });

  it('omits the footer for a complete untruncated read', () => {
    const part = makeCompletedPart({
      metadata: {
        display: {
          type: 'file',
          path: '/repo/README.md',
          text: '# Title',
          lineStart: 1,
          lineEnd: 3,
          totalLines: 3,
          truncated: false,
        },
      },
    });
    expect(resolveMarkdownBody(part)?.footer).toBeUndefined();
  });

  it('formats a windowed footer with en dash and thousands separator', () => {
    const part = makeCompletedPart({
      filePath: '/repo/BIG.md',
      metadata: {
        display: {
          type: 'file',
          path: '/repo/BIG.md',
          text: '## Middle',
          lineStart: 201,
          lineEnd: 400,
          totalLines: 1450,
          truncated: true,
        },
      },
    });
    expect(resolveMarkdownBody(part)?.footer).toBe('lines 201–400 of 1,450');
  });

  it('formats a byte-capped footer ending with (truncated)', () => {
    const part = makeCompletedPart({
      output: CAPPED,
      metadata: {},
    });
    const footer = resolveMarkdownBody(part)?.footer;
    expect(footer).toBeDefined();
    expect(footer?.endsWith('(truncated)')).toBe(true);
  });

  it('keeps the full markdown over 2000 chars without truncation', () => {
    const longText = `${'a'.repeat(100)}\n`.repeat(30);
    expect(longText.length).toBeGreaterThan(2000);
    const part = makeCompletedPart({
      metadata: {
        display: {
          type: 'file',
          path: '/repo/LONG.md',
          text: longText,
          lineStart: 1,
          lineEnd: 30,
          totalLines: 30,
        },
      },
    });
    const body = resolveMarkdownBody(part);
    expect(body?.text).toBe(balanceCodeFences(longText));
  });

  it('returns empty text for an empty file display', () => {
    const part = makeCompletedPart({
      filePath: '/repo/EMPTY.md',
      metadata: {
        display: {
          type: 'file',
          path: '/repo/EMPTY.md',
          text: '',
          lineStart: 1,
          lineEnd: 0,
          totalLines: 0,
        },
      },
    });
    const body = resolveMarkdownBody(part);
    expect(body?.text).toBe('');
    expect(body?.footer).toBeUndefined();
  });
});
