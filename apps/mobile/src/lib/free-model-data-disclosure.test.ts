import { describe, expect, it } from 'vitest';
import {
  BYOK_MODEL_LABEL,
  FREE_MODEL_DATA_LABEL,
  FREE_MODEL_FREE_LABEL,
  getFreeModelDataAccessibilityLabel,
  hasUserByokAvailable,
  isFreeModelOption,
  mayTrainOnYourPrompts,
} from './free-model-data-disclosure';

describe('free model data disclosure', () => {
  it('uses the disclosure label expected in model pickers', () => {
    expect(BYOK_MODEL_LABEL).toBe('BYOK');
    expect(FREE_MODEL_DATA_LABEL).toBe('Data collected');
    expect(FREE_MODEL_FREE_LABEL).toBe('Free');
  });

  it('detects explicit and known free model options', () => {
    expect(isFreeModelOption({ id: 'anthropic/claude', isFree: true })).toBe(true);
    expect(isFreeModelOption({ id: 'openrouter/free', isFree: true })).toBe(true);
    expect(isFreeModelOption({ id: 'openrouter/free' })).toBe(false);
    expect(isFreeModelOption({ id: 'openrouter/model-alpha' })).toBe(false);
    expect(isFreeModelOption({ id: 'anthropic/claude' })).toBe(false);
  });

  it('detects training eligibility independently of freeness', () => {
    expect(
      mayTrainOnYourPrompts({
        id: 'paid-training-model',
        isFree: false,
        mayTrainOnYourPrompts: true,
      })
    ).toBe(true);
    expect(
      mayTrainOnYourPrompts({
        id: 'free-private-model',
        isFree: true,
        mayTrainOnYourPrompts: false,
      })
    ).toBe(false);
    expect(mayTrainOnYourPrompts({ id: 'free-model', isFree: true })).toBe(false);
  });

  it('detects only explicit user BYOK availability', () => {
    expect(
      hasUserByokAvailable({
        id: 'anthropic/claude',
        hasUserByokAvailable: true,
      })
    ).toBe(true);
    expect(
      hasUserByokAvailable({
        id: 'anthropic/claude',
        hasUserByokAvailable: false,
      })
    ).toBe(false);
    expect(hasUserByokAvailable({ id: 'anthropic/claude' })).toBe(false);
  });

  it('adds a data collection phrase to accessibility labels', () => {
    expect(getFreeModelDataAccessibilityLabel('Kilo Auto')).toBe('Kilo Auto, Data collected');
  });
});
