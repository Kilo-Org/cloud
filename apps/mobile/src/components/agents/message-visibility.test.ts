import { type Part, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { messageRendersContent, partRendersContent } from './message-visibility';

function textPart(overrides: Partial<Extract<Part, { type: 'text' }>> = {}): Part {
  return {
    id: 'p1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'text',
    text: 'hello',
    ...overrides,
  };
}

function reasoningPart(text: string): Part {
  return {
    id: 'p2',
    sessionID: 's1',
    messageID: 'm1',
    type: 'reasoning',
    text,
    time: { start: 1, end: 2 },
  };
}

function toolPart(tool: string): Part {
  return {
    id: 'p3',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state: {
      status: 'completed',
      input: {},
      output: '',
      title: 't',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function patchPart(files: string[]): Part {
  return {
    id: 'p4',
    sessionID: 's1',
    messageID: 'm1',
    type: 'patch',
    hash: 'abc',
    files,
  };
}

function assistantMessage(parts: Part[]): StoredMessage {
  return {
    info: {
      id: 'm1',
      sessionID: 's1',
      role: 'assistant',
      time: { created: 1 },
      parentID: 'm0',
      modelID: 'model',
      providerID: 'kilo',
      mode: 'code',
      agent: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  };
}

describe('partRendersContent', () => {
  it('returns false for a step-start part', () => {
    const part: Part = { id: 'p', sessionID: 's1', messageID: 'm1', type: 'step-start' };
    expect(partRendersContent(part)).toBe(false);
  });

  it('returns false for a synthetic Initializing snapshot text part', () => {
    expect(
      partRendersContent(textPart({ synthetic: true, text: '⠋ Initializing snapshot…' }))
    ).toBe(false);
  });

  it('returns false for a reasoning part with whitespace-only text', () => {
    expect(partRendersContent(reasoningPart('   \n  '))).toBe(false);
  });

  it('returns false for a plan_exit tool part', () => {
    expect(partRendersContent(toolPart('plan_exit'))).toBe(false);
  });

  it('returns false for an empty text part', () => {
    expect(partRendersContent(textPart({ text: '' }))).toBe(false);
  });

  it('returns false for a whitespace-only text part', () => {
    expect(partRendersContent(textPart({ text: '\n\n' }))).toBe(false);
    expect(partRendersContent(textPart({ text: '   ' }))).toBe(false);
  });

  it('returns true for a bash tool part', () => {
    expect(partRendersContent(toolPart('bash'))).toBe(true);
  });

  it('returns true for a compaction part', () => {
    const part: Part = {
      id: 'p',
      sessionID: 's1',
      messageID: 'm1',
      type: 'compaction',
      auto: true,
    };
    expect(partRendersContent(part)).toBe(true);
  });

  it('returns true for a file part', () => {
    const part: Part = {
      id: 'p',
      sessionID: 's1',
      messageID: 'm1',
      type: 'file',
      mime: 'text/plain',
      url: 'file:///a.txt',
    };
    expect(partRendersContent(part)).toBe(true);
  });

  it('returns true for a patch part with files', () => {
    expect(partRendersContent(patchPart(['src/a.ts', 'src/b.ts']))).toBe(true);
  });

  it('returns false for a patch part with no files', () => {
    expect(partRendersContent(patchPart([]))).toBe(false);
  });
});

describe('messageRendersContent', () => {
  it('returns false for an assistant message with zero parts', () => {
    expect(messageRendersContent(assistantMessage([]))).toBe(false);
  });

  it('returns false for an assistant message whose only part is step-start', () => {
    const part: Part = { id: 'p', sessionID: 's1', messageID: 'm1', type: 'step-start' };
    expect(messageRendersContent(assistantMessage([part]))).toBe(false);
  });

  it('returns true when a retry part is followed by a non-empty text part', () => {
    const retry: Part = {
      id: 'p-retry',
      sessionID: 's1',
      messageID: 'm1',
      type: 'retry',
      attempt: 1,
      error: {
        name: 'APIError',
        data: { message: 'nope', isRetryable: true },
      },
      time: { created: 1 },
    };
    expect(messageRendersContent(assistantMessage([retry, textPart()]))).toBe(true);
  });

  it('returns true for a user message with zero parts', () => {
    const user: StoredMessage = {
      info: {
        id: 'm1',
        sessionID: 's1',
        role: 'user',
        time: { created: 1 },
        agent: 'build',
        model: { providerID: 'openrouter', modelID: 'model' },
      },
      parts: [],
    };
    expect(messageRendersContent(user)).toBe(true);
  });
});
