import type { Part, ReasoningPart, StepFinishPart, TextPart, ToolPart } from './types';
import { getStepFinishRoutedModel, normalizeMissingPartText } from './part-utils';

function stepFinishPart(overrides: Partial<StepFinishPart> = {}): StepFinishPart {
  return {
    id: 'p-finish',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'step-finish',
    reason: 'stop',
    cost: 0.001,
    tokens: {
      input: 1,
      output: 2,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...overrides,
  };
}

describe('getStepFinishRoutedModel', () => {
  it('returns the ref when a well-formed model is present', () => {
    const part = stepFinishPart({
      // The field is present on the wire / in the Zod contract but absent from
      // the generated type, so the test mirrors the runtime shape.
      ...({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      } as Partial<StepFinishPart>),
    });

    expect(getStepFinishRoutedModel(part)).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
    });
  });

  it('returns undefined when the model field is absent', () => {
    expect(getStepFinishRoutedModel(stepFinishPart())).toBeUndefined();
  });

  it('returns undefined when the model field is null', () => {
    const part = stepFinishPart({
      ...({ model: null } as unknown as Partial<StepFinishPart>),
    });
    expect(getStepFinishRoutedModel(part)).toBeUndefined();
  });

  it('returns undefined when the model field is a primitive', () => {
    const part = stepFinishPart({
      ...({ model: 'anthropic/claude-sonnet-4' } as unknown as Partial<StepFinishPart>),
    });
    expect(getStepFinishRoutedModel(part)).toBeUndefined();
  });

  it('returns undefined when providerID is missing or empty', () => {
    const missing = stepFinishPart({
      ...({ model: { modelID: 'claude-sonnet-4' } } as Partial<StepFinishPart>),
    });
    const empty = stepFinishPart({
      ...({ model: { providerID: '', modelID: 'claude-sonnet-4' } } as Partial<StepFinishPart>),
    });
    const wrongType = stepFinishPart({
      ...({
        model: { providerID: 42, modelID: 'claude-sonnet-4' },
      } as unknown as Partial<StepFinishPart>),
    });

    expect(getStepFinishRoutedModel(missing)).toBeUndefined();
    expect(getStepFinishRoutedModel(empty)).toBeUndefined();
    expect(getStepFinishRoutedModel(wrongType)).toBeUndefined();
  });

  it('returns undefined when modelID is missing or empty', () => {
    const missing = stepFinishPart({
      ...({ model: { providerID: 'anthropic' } } as Partial<StepFinishPart>),
    });
    const empty = stepFinishPart({
      ...({ model: { providerID: 'anthropic', modelID: '' } } as Partial<StepFinishPart>),
    });
    const wrongType = stepFinishPart({
      ...({
        model: { providerID: 'anthropic', modelID: null },
      } as unknown as Partial<StepFinishPart>),
    });

    expect(getStepFinishRoutedModel(missing)).toBeUndefined();
    expect(getStepFinishRoutedModel(empty)).toBeUndefined();
    expect(getStepFinishRoutedModel(wrongType)).toBeUndefined();
  });
});

describe('normalizeMissingPartText', () => {
  it('returns the identical object when the text is already a string', () => {
    const textPart: TextPart = {
      id: 'p-text',
      sessionID: 'ses-1',
      messageID: 'msg-1',
      type: 'text',
      text: 'hello',
    };
    const reasoningPart: ReasoningPart = {
      id: 'p-reasoning',
      sessionID: 'ses-1',
      messageID: 'msg-1',
      type: 'reasoning',
      text: 'thinking',
      time: { start: 1, end: 2 },
    };

    // Identity is preserved so memoized stored messages keep their reference.
    expect(normalizeMissingPartText(textPart)).toBe(textPart);
    expect(normalizeMissingPartText(reasoningPart)).toBe(reasoningPart);
  });

  it('fills an empty string for a text part missing the text field', () => {
    const part = {
      id: 'p-text',
      sessionID: 'ses-1',
      messageID: 'msg-1',
      type: 'text',
    } as unknown as TextPart;

    const normalized = normalizeMissingPartText(part);
    expect(normalized).not.toBe(part);
    expect((normalized satisfies Part as TextPart).text).toBe('');
    expect(normalized.id).toBe('p-text');
  });

  it('fills an empty string for a reasoning part missing the text field', () => {
    const part = {
      id: 'p-reasoning',
      sessionID: 'ses-1',
      messageID: 'msg-1',
      type: 'reasoning',
      time: { start: 1, end: 2 },
    } as unknown as ReasoningPart;

    const normalized = normalizeMissingPartText(part);
    expect((normalized satisfies Part as ReasoningPart).text).toBe('');
  });

  it('fills an empty string for a part carrying null text', () => {
    const textPart = {
      id: 'p-text',
      sessionID: 'ses-1',
      messageID: 'msg-1',
      type: 'text',
      text: null,
    } as unknown as TextPart;
    const reasoningPart = {
      id: 'p-reasoning',
      sessionID: 'ses-1',
      messageID: 'msg-1',
      type: 'reasoning',
      text: null,
      time: { start: 1, end: 2 },
    } as unknown as ReasoningPart;

    expect((normalizeMissingPartText(textPart) satisfies Part as TextPart).text).toBe('');
    expect((normalizeMissingPartText(reasoningPart) satisfies Part as ReasoningPart).text).toBe('');
  });

  it('passes non-text parts through unchanged', () => {
    const toolPart: ToolPart = {
      id: 'p-tool',
      sessionID: 'ses-1',
      messageID: 'msg-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'read',
      state: {
        status: 'completed',
        input: { filePath: '/a.ts' },
        output: 'ok',
        title: 'read',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
    const stepFinishPart: StepFinishPart = {
      id: 'p-finish',
      sessionID: 'ses-1',
      messageID: 'msg-1',
      type: 'step-finish',
      reason: 'stop',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };

    expect(normalizeMissingPartText(toolPart)).toBe(toolPart);
    expect(normalizeMissingPartText(stepFinishPart)).toBe(stepFinishPart);
  });
});
