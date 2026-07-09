import { describe, expect, it } from '@jest/globals';
import {
  filterModelsForCloudAgentBalance,
  getNewSessionBalanceNotice,
} from './new-session-balance';

const models = [
  { id: 'paid', isFree: false, hasUserByokAvailable: false },
  { id: 'free', isFree: true, hasUserByokAvailable: false },
  { id: 'byok', isFree: false, hasUserByokAvailable: true },
];

describe('NewSessionPanel balance presentation', () => {
  it('filters a stale paid selection out at zero Credits while retaining free and BYOK models', () => {
    const availableModels = filterModelsForCloudAgentBalance(models, true);

    expect(availableModels.map(model => model.id)).toEqual(['free', 'byok']);
    expect(availableModels.some(model => model.id === 'paid')).toBe(false);
    expect(getNewSessionBalanceNotice(true, true)).toBe('zero-credit');
  });

  it('keeps every model available and shows only a low-funds notice for a positive sub-dollar balance', () => {
    expect(filterModelsForCloudAgentBalance(models, false)).toEqual(models);
    expect(getNewSessionBalanceNotice(false, true)).toBe('low-funds');
  });

  it('shows no balance notice at one dollar or more', () => {
    expect(filterModelsForCloudAgentBalance(models, false)).toEqual(models);
    expect(getNewSessionBalanceNotice(false, false)).toBe('none');
  });
});
