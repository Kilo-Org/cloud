import { describe, expect, it } from '@jest/globals';
import {
  FREE_MODEL_DATA_LABEL,
  FREE_MODEL_FREE_LABEL,
  getFreeModelDataTooltip,
  isFreeKiloGatewayModelOption,
  isFreeModelOption,
} from './free-model-data-disclosure';

describe('free model data disclosure', () => {
  it('uses the disclosure label expected in model pickers', () => {
    expect(FREE_MODEL_DATA_LABEL).toBe('Data collected');
    expect(FREE_MODEL_FREE_LABEL).toBe('Free');
  });

  it('detects explicit and known free model options', () => {
    expect(isFreeModelOption({ id: 'anthropic/claude', isFree: true })).toBe(true);
    expect(isFreeModelOption({ id: 'openrouter/free' })).toBe(true);
    expect(isFreeModelOption({ id: 'openrouter/model-alpha' })).toBe(false);
    expect(isFreeModelOption({ id: 'anthropic/claude' })).toBe(false);
  });

  it('only marks Kilo Gateway free models as data collected', () => {
    expect(isFreeKiloGatewayModelOption({ id: 'kilo-auto/free' })).toBe(true);
    expect(isFreeKiloGatewayModelOption({ id: 'kilo-auto/frontier', isFree: true })).toBe(true);
    expect(isFreeKiloGatewayModelOption({ id: 'openrouter/free' })).toBe(false);
    expect(isFreeKiloGatewayModelOption({ id: 'anthropic/claude', isFree: true })).toBe(false);
  });

  it('uses the short disclosure text as tooltip content', () => {
    expect(getFreeModelDataTooltip()).toBe('Data collected');
  });
});
