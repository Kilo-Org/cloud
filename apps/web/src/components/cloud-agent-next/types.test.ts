import type { ReasoningPart, TextPart } from './types';
import {
  getCloudSessionCreationOperation,
  isAmbiguousCloudSessionCreationError,
  isPartStreaming,
  shouldRenderReasoningPart,
} from './types';

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

function makeTextPart(text: string): TextPart {
  return {
    id: 't1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'text',
    text,
    time: { start: 1, end: 2 },
  };
}

const encryptedMetadata = [
  {
    name: 'OpenAI encrypted content',
    metadata: { openai: { reasoningEncryptedContent: 'encrypted-reasoning' } },
  },
  {
    name: 'Copilot encrypted content',
    metadata: { copilot: { reasoningEncryptedContent: 'encrypted-reasoning' } },
  },
  {
    name: 'OpenRouter encrypted-only details',
    metadata: {
      openrouter: {
        reasoning_details: [{ type: 'reasoning.encrypted', data: 'encrypted-reasoning' }],
      },
    },
  },
  {
    name: 'Anthropic redacted data',
    metadata: { anthropic: { redactedData: 'redacted-reasoning' } },
  },
] satisfies { name: string; metadata: ReasoningPart['metadata'] }[];

describe('shouldRenderReasoningPart', () => {
  it.each([
    { name: 'empty', text: '' },
    { name: 'whitespace-only', text: '   \n\t  ' },
    { name: 'redacted-only', text: '[REDACTED]' },
    { name: 'adjacent repeated redactions', text: '[REDACTED][REDACTED]' },
    { name: 'redactions separated by whitespace', text: ' \n[REDACTED]\t[REDACTED]  ' },
    { name: 'empty HTML comment', text: '<!-- -->' },
    { name: 'HTML comment placeholder', text: '<!-- reasoning unavailable -->' },
    { name: 'multiline HTML comments', text: ' <!-- first\nplaceholder -->\n<!-- second --> ' },
    { name: 'streaming comment opener', text: ' \n<!--\t ' },
    { name: 'comments mixed with redactions', text: '[REDACTED]<!-- placeholder -->[REDACTED]' },
  ])('hides $name reasoning whether completed or streaming', ({ text }) => {
    for (const ended of [true, false]) {
      const part = makeReasoningPart(text, ended);
      expect(isPartStreaming(part)).toBe(!ended);
      expect(shouldRenderReasoningPart(part)).toBe(false);
    }
  });

  it.each([
    'thinking through the steps',
    'Check [REDACTED] before continuing.',
    '[REDACTED]The answer depends on the input.[REDACTED]',
    '<!-- placeholder -->Check the input.<!-- another placeholder -->',
    '<!--\nThe next step is still streaming.',
    '## Inspect the parser\n\n<!-- -->',
  ])('renders meaningful text %j whether completed or streaming', text => {
    for (const ended of [true, false]) {
      const part = makeReasoningPart(text, ended);
      expect(shouldRenderReasoningPart(part)).toBe(true);
      expect(part.text).toBe(text);
    }
  });

  it.each(encryptedMetadata)('hides blank reasoning with $name metadata', ({ metadata }) => {
    for (const text of ['', ' \n\t ', '[REDACTED]', '<!-- placeholder -->', '<!--']) {
      expect(shouldRenderReasoningPart({ ...makeReasoningPart(text), metadata })).toBe(false);
    }
  });

  it.each([
    ...encryptedMetadata,
    {
      name: 'OpenRouter encrypted and text details',
      metadata: {
        openrouter: {
          reasoning_details: [
            { type: 'reasoning.encrypted', data: 'encrypted-reasoning' },
            { type: 'reasoning.text', text: 'Provider reasoning text' },
          ],
        },
      },
    },
    {
      name: 'OpenRouter encrypted and summary details',
      metadata: {
        openrouter: {
          reasoning_details: [
            { type: 'reasoning.encrypted', data: 'encrypted-reasoning' },
            { type: 'reasoning.summary', summary: 'Provider reasoning summary' },
          ],
        },
      },
    },
    {
      name: 'Anthropic signature',
      metadata: { anthropic: { signature: 'reasoning-signature' } },
    },
  ])('renders readable text alongside $name metadata', ({ metadata }) => {
    const part = { ...makeReasoningPart('thinking through the steps'), metadata };
    expect(shouldRenderReasoningPart(part)).toBe(true);
  });

  it('does not mutate frozen reasoning text or provider metadata when ignoring placeholders', () => {
    const part = {
      ...makeReasoningPart('<!-- placeholder -->Check [REDACTED] before continuing.'),
      metadata: { anthropic: { signature: 'reasoning-signature' } },
    };
    const original = structuredClone(part);
    Object.freeze(part.metadata.anthropic);
    Object.freeze(part.metadata);
    Object.freeze(part);

    expect(shouldRenderReasoningPart(part)).toBe(true);
    expect(part).toEqual(original);
  });

  it('does not render a non-reasoning part', () => {
    expect(shouldRenderReasoningPart(makeTextPart('hello'))).toBe(false);
  });
});

describe('getCloudSessionCreationOperation', () => {
  it('retains one operation key when the immutable creation intent is retried', () => {
    const createOperationKey = jest.fn(() => 'operation-first');
    const original = {
      ...getCloudSessionCreationOperation(null, 'same intent', createOperationKey),
      initialMessageId: 'message-first',
    };

    expect(getCloudSessionCreationOperation(original, 'same intent', createOperationKey)).toBe(
      original
    );
    expect(createOperationKey).toHaveBeenCalledTimes(1);
  });

  it('creates a new operation key when the immutable intent changes', () => {
    const createOperationKey = jest
      .fn()
      .mockReturnValueOnce('operation-first')
      .mockReturnValueOnce('operation-second');
    const original = getCloudSessionCreationOperation(null, 'first intent', createOperationKey);

    expect(
      getCloudSessionCreationOperation(original, 'changed intent', createOperationKey)
    ).toEqual({ intent: 'changed intent', operationKey: 'operation-second' });
  });
});

describe('isAmbiguousCloudSessionCreationError', () => {
  it('retains the operation for transport and server failures with an unknown outcome', () => {
    expect(isAmbiguousCloudSessionCreationError(new Error('Network unavailable'))).toBe(true);
    expect(isAmbiguousCloudSessionCreationError({ data: { code: 'TIMEOUT' } })).toBe(true);
    expect(isAmbiguousCloudSessionCreationError({ data: { code: 'INTERNAL_SERVER_ERROR' } })).toBe(
      true
    );
  });

  it.each(['creation_in_progress', 'operation_in_progress'])(
    'retains the operation for the retryable %s conflict',
    message => {
      expect(
        isAmbiguousCloudSessionCreationError({
          data: { code: 'CONFLICT' },
          message,
        })
      ).toBe(true);
    }
  );

  it('clears the operation after definitive authorization, validation, and intent failures', () => {
    expect(isAmbiguousCloudSessionCreationError({ data: { code: 'FORBIDDEN' } })).toBe(false);
    expect(isAmbiguousCloudSessionCreationError({ data: { code: 'BAD_REQUEST' } })).toBe(false);
    expect(
      isAmbiguousCloudSessionCreationError({
        data: { code: 'CONFLICT' },
        message: 'operation_key_reuse_mismatch',
      })
    ).toBe(false);
  });
});
