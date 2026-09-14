import {
  type FilePart,
  type PatchPart,
  type ReasoningPart,
  type StoredMessage,
  type TextPart,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { assistantMessage } from './message-bubble-test-utils';
import {
  isPartStreaming,
  isPatchPart,
  isSnapshotProgressPart,
  shouldRenderReasoningPart,
  withoutReasoningParts,
} from './part-types';

function makeReasoningPart(text: string, ended = true): ReasoningPart {
  return {
    id: 'r1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'reasoning',
    text,
    time: { start: 1, end: ended ? 2 : undefined },
  };
}

function makeTextPart(text: string, synthetic?: boolean): TextPart {
  const part: TextPart = {
    id: 't1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'text',
    text,
    time: { start: 1, end: 2 },
  };
  if (synthetic !== undefined) {
    part.synthetic = synthetic;
  }
  return part;
}

function makeToolPart(): ToolPart {
  return {
    id: 'tool-1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    tool: 'read',
    callID: 'call-1',
    state: {
      status: 'completed',
      input: { filePath: 'src/a.ts' },
      output: 'contents',
      title: 'Read',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function storedMessage(id: string, parts: StoredMessage['parts']): StoredMessage {
  return { info: assistantMessage(id).info, parts };
}

describe('isSnapshotProgressPart', () => {
  it('is true for a synthetic text part whose text includes Initializing snapshot', () => {
    const part = makeTextPart('⠋ Initializing snapshot…', true);
    expect(isSnapshotProgressPart(part)).toBe(true);
  });

  it('is false for the same text when not synthetic', () => {
    const part = makeTextPart('⠋ Initializing snapshot…', false);
    expect(isSnapshotProgressPart(part)).toBe(false);
  });

  it('is false for a synthetic text part with other content', () => {
    const part = makeTextPart('Hello from the agent', true);
    expect(isSnapshotProgressPart(part)).toBe(false);
  });

  it('is false for non-text parts', () => {
    const part = makeReasoningPart('thinking');
    expect(isSnapshotProgressPart(part)).toBe(false);
  });
});

describe('isPatchPart', () => {
  it('is true for a patch part', () => {
    const part: PatchPart = {
      id: 'p1',
      sessionID: 's1',
      messageID: 'm1',
      type: 'patch',
      hash: 'abc',
      files: ['src/a.ts'],
    };
    expect(isPatchPart(part)).toBe(true);
  });

  it('is false for a file part', () => {
    const part: FilePart = {
      id: 'p1',
      sessionID: 's1',
      messageID: 'm1',
      type: 'file',
      mime: 'text/plain',
      url: 'file:///a.txt',
    };
    expect(isPatchPart(part)).toBe(false);
  });
});

describe('isPartStreaming', () => {
  it('does not treat a reasoning part with no time as streaming', () => {
    const part = makeReasoningPart('thinking');
    delete (part as { time?: unknown }).time;
    expect(isPartStreaming(part)).toBe(false);
  });
});

describe('shouldRenderReasoningPart', () => {
  it('does not render a completed reasoning part with empty text', () => {
    const part = makeReasoningPart('', true);
    expect(shouldRenderReasoningPart(part, false)).toBe(false);
  });

  it('does not render a completed reasoning part with whitespace-only text', () => {
    const part = makeReasoningPart('   \n\t  ', true);
    expect(shouldRenderReasoningPart(part, false)).toBe(false);
  });

  it('renders a completed reasoning part with meaningful text', () => {
    const part = makeReasoningPart('thinking through the steps', true);
    expect(shouldRenderReasoningPart(part, false)).toBe(true);
  });

  it('does not render a reasoning part that is empty while effectively streaming', () => {
    const part = makeReasoningPart('', false);
    expect(isPartStreaming(part)).toBe(true);
    expect(shouldRenderReasoningPart(part, true)).toBe(false);
  });

  it('does not render a whitespace-only unfinished reasoning part while the parent is streaming', () => {
    const part = makeReasoningPart('   \n\t  ', false);
    expect(isPartStreaming(part)).toBe(true);
    expect(shouldRenderReasoningPart(part, true)).toBe(false);
  });

  it('does not render a non-reasoning part', () => {
    const part = makeTextPart('hello');
    expect(shouldRenderReasoningPart(part, false)).toBe(false);
  });

  it('does not render a finished-but-empty reasoning part even if the parent reports streaming', () => {
    const part = makeReasoningPart('', true);
    expect(isPartStreaming(part)).toBe(false);
    expect(shouldRenderReasoningPart(part, true)).toBe(false);
  });

  it('does not render an unfinished empty reasoning part when the parent is not streaming', () => {
    const part = makeReasoningPart('', false);
    expect(isPartStreaming(part)).toBe(true);
    expect(shouldRenderReasoningPart(part, false)).toBe(false);
  });

  it('does not render a reasoning part with no text', () => {
    const part = makeReasoningPart('thinking');
    delete (part as { text?: unknown }).text;
    expect(shouldRenderReasoningPart(part, false)).toBe(false);
  });
});

describe('withoutReasoningParts', () => {
  it('removes reasoning while keeping text and tool parts', () => {
    const text = makeTextPart('answer');
    const tool = makeToolPart();
    const message = storedMessage('m1', [makeReasoningPart('thinking'), text, tool]);

    const result = withoutReasoningParts([message]);

    expect(result[0]?.parts).toEqual([text, tool]);
    expect(result[0]?.parts.some(part => part.type === 'reasoning')).toBe(false);
  });

  it('returns the same array reference when no message has reasoning', () => {
    const messages: StoredMessage[] = [
      storedMessage('m1', [makeTextPart('a')]),
      storedMessage('m2', [makeToolPart()]),
    ];

    expect(withoutReasoningParts(messages)).toBe(messages);
  });

  it('keeps message identity for unchanged messages', () => {
    const unchanged = storedMessage('m1', [makeTextPart('a')]);
    const changed = storedMessage('m2', [makeReasoningPart('thinking'), makeTextPart('b')]);

    const result = withoutReasoningParts([unchanged, changed]);

    expect(result[0]).toBe(unchanged);
    expect(result[1]).not.toBe(changed);
    expect(result[1]?.info).toBe(changed.info);
    expect(result[1]?.parts.map(part => part.type)).toEqual(['text']);
  });
});
