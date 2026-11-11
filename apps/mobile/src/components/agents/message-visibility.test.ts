import { type Part, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  messageRendersContent,
  partRendersContent,
  userBubbleRendersContent,
} from './message-visibility';

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

  it('answers a new part version on its own, as streaming produces one per change', () => {
    const blank = textPart({ text: '' });
    expect(partRendersContent(blank)).toBe(false);
    expect(partRendersContent(blank)).toBe(false);
    // The session storage replaces the part object when text streams in.
    const streamed = { ...blank, text: 'hello' };
    expect(partRendersContent(streamed)).toBe(true);
    const sanitizedAway = { ...streamed, text: '<script>hidden</script>' };
    expect(partRendersContent(sanitizedAway)).toBe(false);
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

  it('returns false for a patch part whose files field the wire omitted', () => {
    // Sentry KILO-APP-BZ: the live `message.part.updated` payload is parsed
    // with `.passthrough()`, so a patch part can reach storage without `files`.
    const part = {
      id: 'p4',
      sessionID: 's1',
      messageID: 'm1',
      type: 'patch',
      hash: 'abc',
    } as unknown as Part;
    expect(partRendersContent(part)).toBe(false);
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

  it('returns false for a user message whose only text is removed during HTML sanitization', () => {
    const user: StoredMessage = {
      info: {
        id: 'm1',
        sessionID: 's1',
        role: 'user',
        time: { created: 1 },
        agent: 'build',
        model: { providerID: 'openrouter', modelID: 'model' },
      },
      parts: [textPart({ text: "<script>alert('bad')</script>" })],
    };
    expect(messageRendersContent(user)).toBe(false);
  });

  it.each([
    '<!-- hidden -->',
    '<form><input value="hidden"></form>',
    '<iframe>hidden</iframe><style>hidden</style>',
    '<div><script>alert("bad")</script></div>',
    '<section><form><input></form></section>',
    '<span><iframe></iframe></span><p></p>',
  ])('returns false when sanitization removes %s', text => {
    expect(partRendersContent(textPart({ text }))).toBe(false);
  });

  it.each(['before<script>hidden</script>', '<section>safe</section>', '<hr>'])(
    'keeps visible content in %s',
    text => {
      expect(partRendersContent(textPart({ text }))).toBe(true);
    }
  );
});

describe('userBubbleRendersContent', () => {
  it('returns true for a human prompt', () => {
    expect(userBubbleRendersContent([textPart({ text: 'fix the parser' })])).toBe(true);
  });

  it('returns false for a row with no parts', () => {
    expect(userBubbleRendersContent([])).toBe(false);
  });

  it('returns false when the only text part is the synthetic routing context', () => {
    // The bubble renders human text through `humanTextParts`, which drops the
    // server's context wrapper: accepting the wrapper here would draw an empty
    // bubble inside the row's long-press surface.
    expect(
      userBubbleRendersContent([
        textPart({ synthetic: true, text: '<cloud-agent-context session-id="w1" />' }),
      ])
    ).toBe(false);
  });

  it('returns true when a context wrapper sits beside the prompt', () => {
    expect(
      userBubbleRendersContent([
        textPart({ synthetic: true, text: '<cloud-agent-context session-id="w1" />' }),
        textPart({ id: 'p2', text: 'fix the parser' }),
      ])
    ).toBe(true);
  });

  it('returns false for blank text and for a prompt sanitization removes', () => {
    expect(userBubbleRendersContent([textPart({ text: '   \n ' })])).toBe(false);
    expect(userBubbleRendersContent([textPart({ text: "<script>alert('x')</script>" })])).toBe(
      false
    );
  });

  it('returns false for tool, reasoning and patch parts the bubble never draws', () => {
    expect(userBubbleRendersContent([toolPart('bash')])).toBe(false);
    expect(userBubbleRendersContent([reasoningPart('thinking')])).toBe(false);
    expect(userBubbleRendersContent([patchPart(['src/a.ts'])])).toBe(false);
  });

  it('returns true for a file attachment', () => {
    const file: Part = {
      id: 'p-file',
      sessionID: 's1',
      messageID: 'm1',
      type: 'file',
      mime: 'text/plain',
      url: 'file:///a.txt',
    };
    expect(userBubbleRendersContent([file])).toBe(true);
  });
});
