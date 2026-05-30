import { describe, expect, it } from 'vitest';
import {
  FREE_MODEL_DATA_LABEL,
  getFreeModelDataAccessibilityLabel,
  isFreeModelOption,
} from './free-model-data-disclosure';

describe('free model data disclosure', () => {
  it('uses the disclosure label expected in model pickers', () => {
    expect(FREE_MODEL_DATA_LABEL).toBe('Free - data collected');
  });

  it('detects explicit and known free model options', () => {
    expect(isFreeModelOption({ id: 'anthropic/claude', isFree: true })).toBe(true);
    expect(isFreeModelOption({ id: 'openrouter/free' })).toBe(true);
    expect(isFreeModelOption({ id: 'openrouter/model-alpha' })).toBe(true);
    expect(isFreeModelOption({ id: 'anthropic/claude' })).toBe(false);
  });

  it('adds a data collection phrase to accessibility labels', () => {
    expect(getFreeModelDataAccessibilityLabel('Kilo Auto')).toBe(
      'Kilo Auto, free model, usage data collected'
    );
  });
});
