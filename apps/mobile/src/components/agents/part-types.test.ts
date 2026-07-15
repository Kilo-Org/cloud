import { type Part, type ReasoningPart } from 'cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { isPartStreaming, shouldRenderReasoningPart } from './part-types';

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

function makeTextPart(text: string): Part {
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

  it('renders a reasoning part that is empty while effectively streaming', () => {
    const part = makeReasoningPart('', false);
    expect(isPartStreaming(part)).toBe(true);
    expect(shouldRenderReasoningPart(part, true)).toBe(true);
  });

  it('renders a whitespace-only unfinished reasoning part while the parent is streaming', () => {
    const part = makeReasoningPart('   \n\t  ', false);
    expect(isPartStreaming(part)).toBe(true);
    expect(shouldRenderReasoningPart(part, true)).toBe(true);
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
});
