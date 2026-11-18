import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isRtlLanguage, syncRtl } from './rtl';

const mocks = vi.hoisted(() => ({
  i18nManager: { allowRTL: vi.fn(), forceRTL: vi.fn(), isRTL: false },
}));

vi.mock('react-native', () => ({ I18nManager: mocks.i18nManager }));

describe('syncRtl', () => {
  beforeEach(() => {
    mocks.i18nManager.allowRTL.mockReset();
    mocks.i18nManager.forceRTL.mockReset();
    mocks.i18nManager.isRTL = false;
  });

  it('withdraws the device locale direction for a left-to-right language on an RTL device', () => {
    // The native direction is RTL here only because the device locale reads
    // right to left, which is the case forceRTL(false) alone cannot leave.
    mocks.i18nManager.isRTL = true;

    expect(syncRtl('en')).toBe(true);

    expect(mocks.i18nManager.allowRTL).toHaveBeenCalledWith(false);
    expect(mocks.i18nManager.forceRTL).toHaveBeenCalledWith(false);
  });

  it('forces right to left for an RTL language on a left-to-right device', () => {
    expect(syncRtl('ar')).toBe(true);

    expect(mocks.i18nManager.allowRTL).toHaveBeenCalledWith(true);
    expect(mocks.i18nManager.forceRTL).toHaveBeenCalledWith(true);
  });

  it('leaves a direction that already matches untouched', () => {
    expect(syncRtl('en')).toBe(false);

    mocks.i18nManager.isRTL = true;
    expect(syncRtl('he')).toBe(false);

    expect(mocks.i18nManager.allowRTL).not.toHaveBeenCalled();
    expect(mocks.i18nManager.forceRTL).not.toHaveBeenCalled();
  });
});

describe('isRtlLanguage', () => {
  it('names the right-to-left languages of the catalog', () => {
    expect(isRtlLanguage('ar')).toBe(true);
    expect(isRtlLanguage('ur')).toBe(true);
    expect(isRtlLanguage('en')).toBe(false);
    expect(isRtlLanguage('de')).toBe(false);
  });
});
