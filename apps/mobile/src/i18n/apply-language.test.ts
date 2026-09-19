import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { applyLanguagePreference } from './apply-language';

const mocks = vi.hoisted(() => ({
  reloadAppAsync: vi.fn(),
  i18nManager: { allowRTL: vi.fn(), isRTL: false, forceRTL: vi.fn() },
  syncRtl: vi.fn(),
  prewarmIntl: vi.fn(),
  setLanguagePreferenceAsync: vi.fn(),
  writeLanguageReturnTarget: vi.fn(),
  renameAndroidNotificationChannels: vi.fn(),
  registerNeedsInputCategories: vi.fn(),
}));

vi.mock('expo', () => ({ reloadAppAsync: mocks.reloadAppAsync }));
vi.mock('react-native', () => ({ I18nManager: mocks.i18nManager }));
vi.mock('@/i18n/rtl', () => ({
  isRtlLanguage: (language: string) => language === 'ar',
  syncRtl: mocks.syncRtl,
}));
vi.mock('@/i18n/return-target', () => ({
  writeLanguageReturnTarget: mocks.writeLanguageReturnTarget,
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  setLanguagePreferenceAsync: mocks.setLanguagePreferenceAsync,
}));
vi.mock('@/lib/intl-cache', () => ({ prewarmIntl: mocks.prewarmIntl }));
vi.mock('@/lib/notifications', () => ({
  renameAndroidNotificationChannels: mocks.renameAndroidNotificationChannels,
}));
vi.mock('@/lib/notification-actions', () => ({
  registerNeedsInputCategories: mocks.registerNeedsInputCategories,
}));

// The launch-time category registration resolves the button titles from the
// active i18n instance, so every test records the language (and the copy the
// registration would read) at the moment it runs. The production call site
// `void`s the returned promise, so the stub needs no return value.
function trackRegistration(): { languages: string[]; approveTitles: string[] } {
  const languages: string[] = [];
  const approveTitles: string[] = [];
  mocks.registerNeedsInputCategories.mockImplementation(() => {
    languages.push(i18n.language);
    approveTitles.push(i18n.t('common.approve'));
  });
  return { languages, approveTitles };
}

describe('applyLanguagePreference — needs-input category re-registration', () => {
  beforeEach(async () => {
    mocks.setLanguagePreferenceAsync.mockReset().mockResolvedValue(true);
    mocks.renameAndroidNotificationChannels.mockReset().mockResolvedValue(undefined);
    mocks.registerNeedsInputCategories.mockReset().mockResolvedValue(undefined);
    mocks.reloadAppAsync.mockReset().mockResolvedValue(undefined);
    mocks.writeLanguageReturnTarget.mockReset().mockResolvedValue(undefined);
    mocks.syncRtl.mockReset().mockReturnValue(false);
    mocks.i18nManager.isRTL = false;
    mocks.i18nManager.forceRTL.mockReset();
    await i18n.changeLanguage('en');
  });

  it('re-registers the categories under the applied language, not the English default', async () => {
    const registration = trackRegistration();

    await expect(applyLanguagePreference('es', 'es', 'login')).resolves.toEqual({
      kind: 'applied-ltr',
    });

    expect(i18n.language).toBe('es');
    expect(registration.languages).toEqual(['es']);
    // The launch-time registration ran under `lng: 'en'`; the re-registration
    // must observe the applied catalog so the Approve button stops reading
    // English.
    expect(registration.approveTitles).toEqual(['Aprobar']);
    expect(mocks.renameAndroidNotificationChannels).toHaveBeenCalledTimes(1);
  });

  it('registers nothing when the persist write fails and the copy rolls back', async () => {
    mocks.setLanguagePreferenceAsync.mockResolvedValue(false);

    await expect(applyLanguagePreference('es', 'es', 'login')).resolves.toEqual({
      kind: 'persist-failed',
    });

    expect(i18n.language).toBe('en');
    expect(mocks.registerNeedsInputCategories).not.toHaveBeenCalled();
    expect(mocks.renameAndroidNotificationChannels).not.toHaveBeenCalled();
  });

  it('leaves the categories to the cold-start pass when the direction change reloads', async () => {
    mocks.syncRtl.mockReturnValue(true);

    await expect(applyLanguagePreference('ar', 'ar', 'login')).resolves.toEqual({
      kind: 'restarting-rtl',
    });

    // The reload tears this JS context down; the relaunched app registers the
    // categories in prepareLanguage after applying the stored language.
    expect(mocks.registerNeedsInputCategories).not.toHaveBeenCalled();
    expect(mocks.renameAndroidNotificationChannels).not.toHaveBeenCalled();
  });

  it('registers nothing when the catalog fails to load', async () => {
    const changeLanguageSpy = vi
      .spyOn(i18n, 'changeLanguage')
      .mockRejectedValueOnce(new Error('catalog failed'));

    await expect(applyLanguagePreference('es', 'es', 'login')).resolves.toEqual({
      kind: 'catalog-failed',
    });

    expect(mocks.registerNeedsInputCategories).not.toHaveBeenCalled();
    changeLanguageSpy.mockRestore();
  });
});
