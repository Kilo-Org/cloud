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

describe('shouldRenderReasoningPart', () => {
  it('does not render a completed reasoning part with empty text', () => {
    expect(shouldRenderReasoningPart(makeReasoningPart('', true))).toBe(false);
  });

  it('does not render a completed reasoning part with whitespace-only text', () => {
    expect(shouldRenderReasoningPart(makeReasoningPart('   \n\t  ', true))).toBe(false);
  });

  it('renders a completed reasoning part with meaningful text', () => {
    expect(shouldRenderReasoningPart(makeReasoningPart('thinking through the steps', true))).toBe(
      true
    );
  });

  it('does not render a reasoning part that is empty while streaming', () => {
    const part = makeReasoningPart('', false);
    expect(isPartStreaming(part)).toBe(true);
    expect(shouldRenderReasoningPart(part)).toBe(false);
  });

  it('does not render a whitespace-only unfinished reasoning part', () => {
    const part = makeReasoningPart('   \n\t  ', false);
    expect(isPartStreaming(part)).toBe(true);
    expect(shouldRenderReasoningPart(part)).toBe(false);
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
