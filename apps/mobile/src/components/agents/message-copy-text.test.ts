import {
  type FilePart,
  type Part,
  type ReasoningPart,
  type TextPart,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { collectCopyableText } from './collect-copyable-text';

function makeTextPart(overrides: Partial<TextPart> = {}): TextPart {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text: '',
    ...overrides,
  };
}

function makeReasoningPart(overrides: Partial<ReasoningPart> = {}): ReasoningPart {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text: '',
    time: { start: 0 },
    ...overrides,
  };
}

function makeFilePart(overrides: Partial<FilePart> = {}): FilePart {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime: 'text/plain',
    url: 'x',
    ...overrides,
  };
}

function makeToolPart(tool: string, state: ToolPart['state']): ToolPart {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state,
  };
}

function message(parts: Part[]): { parts: Part[] } {
  return { parts };
}

describe('collectCopyableText', () => {
  it('joins text parts and ignores non-text parts', () => {
    expect(
      collectCopyableText(
        message([makeTextPart({ text: 'Hello' }), makeFilePart(), makeTextPart({ text: 'world' })])
      )
    ).toBe('Hello\n\nworld');
  });

  it('returns empty string when no text parts', () => {
    expect(collectCopyableText(message([makeFilePart()]))).toBe('');
  });

  it('excludes synthetic snapshot-progress text parts from copy', () => {
    expect(
      collectCopyableText(
        message([
          makeTextPart({ text: '⠋ Initializing snapshot…', synthetic: true }),
          makeTextPart({ text: 'Real answer' }),
        ])
      )
    ).toBe('Real answer');
  });

  it('keeps non-synthetic text that mentions Initializing snapshot', () => {
    expect(
      collectCopyableText(
        message([makeTextPart({ text: 'Note: Initializing snapshot can take a while' })])
      )
    ).toBe('Note: Initializing snapshot can take a while');
  });

  it('keeps synthetic user optimistic text parts', () => {
    expect(
      collectCopyableText(message([makeTextPart({ text: 'User typed this', synthetic: true })]))
    ).toBe('User typed this');
  });

  it('includes reasoning text parts', () => {
    expect(
      collectCopyableText(
        message([
          makeTextPart({ text: 'First' }),
          makeReasoningPart({ text: 'I should think step by step.' }),
          makeTextPart({ text: 'Second' }),
        ])
      )
    ).toBe('First\n\nI should think step by step.\n\nSecond');
  });

  it('includes a bash tool part with command and output', () => {
    const part = makeToolPart('bash', {
      status: 'completed',
      input: { command: 'ls -la', description: 'List files' },
      output: 'total 0\ndrwxr-xr-x',
      title: 'bash',
      metadata: {},
      time: { start: 0, end: 1 },
    });
    expect(collectCopyableText(message([part]))).toBe(
      'bash\n{\n  "command": "ls -la",\n  "description": "List files"\n}\ntotal 0\ndrwxr-xr-x'
    );
  });

  it('includes a tool part with an error and no output', () => {
    const part = makeToolPart('read', {
      status: 'error',
      input: { filePath: '/missing.txt' },
      error: 'No such file or directory',
      time: { start: 0, end: 1 },
    });
    expect(collectCopyableText(message([part]))).toBe(
      'read\n{\n  "filePath": "/missing.txt"\n}\nError: No such file or directory'
    );
  });

  it('skips a tool part with no input, output, or error', () => {
    const part = makeToolPart('pending_tool', { status: 'pending', input: {}, raw: '' });
    expect(
      collectCopyableText(
        message([makeTextPart({ text: 'Hello' }), part, makeTextPart({ text: 'Goodbye' })])
      )
    ).toBe('Hello\n\nGoodbye');
  });
});
