import { describe, expect, it } from '@jest/globals';
import {
  FREE_MODEL_DATA_LABEL,
  getFreeModelDataTooltip,
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

  it('describes why the free model indicator is shown', () => {
    expect(getFreeModelDataTooltip()).toContain('model improvement');
  });
});
