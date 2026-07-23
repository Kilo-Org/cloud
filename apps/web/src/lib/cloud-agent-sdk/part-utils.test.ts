import type { StepFinishPart } from '@/types/opencode.gen';
import { getStepFinishRoutedModel } from './part-utils';

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
