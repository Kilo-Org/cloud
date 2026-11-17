import {
  parseRuntimeContinuation,
  RUNTIME_CONTINUATION_PROMPTS,
  type RuntimeContinuationReason,
} from './runtime-continuation';
import type { Part, TextPart } from './types';

function textPart(
  text: string,
  flags: Partial<Pick<TextPart, 'synthetic' | 'ignored'>> = {}
): Part {
  return {
    id: 'part-1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'text',
    text,
    ...flags,
  };
}

describe('parseRuntimeContinuation', () => {
  it.each(Object.keys(RUNTIME_CONTINUATION_PROMPTS) as RuntimeContinuationReason[])(
    'recognizes the synthetic %s prompt',
    reason => {
      const text = RUNTIME_CONTINUATION_PROMPTS[reason];
      expect(parseRuntimeContinuation([textPart(text, { synthetic: true })])).toEqual({
        reason,
        text,
      });
    }
  );

  it('matches a synthetic prompt with surrounding whitespace', () => {
    const text = RUNTIME_CONTINUATION_PROMPTS.interrupted;
    expect(parseRuntimeContinuation([textPart(`\n${text}  `, { synthetic: true })])).toEqual({
      reason: 'interrupted',
      text,
    });
  });

  it('ignores an ignored text part beside the prompt', () => {
    const text = RUNTIME_CONTINUATION_PROMPTS.interrupted;
    expect(
      parseRuntimeContinuation([
        textPart('routing context', { synthetic: true, ignored: true }),
        textPart(text, { synthetic: true }),
      ])
    ).toEqual({ reason: 'interrupted', text });
  });

  it('keeps identical typed user text as a user message', () => {
    expect(
      parseRuntimeContinuation([textPart(RUNTIME_CONTINUATION_PROMPTS.interrupted)])
    ).toBeNull();
  });

  it('rejects a prompt with a second visible text part', () => {
    expect(
      parseRuntimeContinuation([
        textPart(RUNTIME_CONTINUATION_PROMPTS.interrupted, { synthetic: true }),
        textPart('extra', { synthetic: true }),
      ])
    ).toBeNull();
  });

  it('rejects a prompt with an attachment', () => {
    expect(
      parseRuntimeContinuation([
        textPart(RUNTIME_CONTINUATION_PROMPTS.interrupted, { synthetic: true }),
        {
          id: 'part-2',
          sessionID: 'ses-1',
          messageID: 'msg-1',
          type: 'file',
          mime: 'image/png',
          url: 'data:image/png;base64,',
        },
      ])
    ).toBeNull();
  });

  it('rejects unknown or partial prompt text', () => {
    expect(
      parseRuntimeContinuation([textPart('Continue from where you left off.', { synthetic: true })])
    ).toBeNull();
    expect(
      parseRuntimeContinuation([
        textPart(`${RUNTIME_CONTINUATION_PROMPTS.interrupted} And add tests.`, { synthetic: true }),
      ])
    ).toBeNull();
  });

  it('rejects empty parts', () => {
    expect(parseRuntimeContinuation([])).toBeNull();
  });
});
