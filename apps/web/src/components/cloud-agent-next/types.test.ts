import type { ReasoningPart, TextPart } from './types';
import { isPartStreaming, shouldRenderReasoningPart } from './types';

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
