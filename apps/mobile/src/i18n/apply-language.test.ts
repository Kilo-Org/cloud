import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  applyDeviceLanguage,
  applyLanguagePreference,
  restorePickedLanguage,
} from './apply-language';

const mocks = vi.hoisted(() => ({
  reloadAppAsync: vi.fn(),
  i18nManager: { allowRTL: vi.fn(), isRTL: false, forceRTL: vi.fn() },
  syncRtl: vi.fn(),
  prewarmIntl: vi.fn(),
  setLanguagePreferenceAsync: vi.fn(),
  preference: 'device' as 'device' | 'es' | 'ar',
  getLanguagePreference: vi.fn(),
  writeLanguageReturnTarget: vi.fn(),
  writeDirectionAttemptAsync: vi.fn(),
  readDirectionAttemptAsync: vi.fn(),
  renameAndroidNotificationChannels: vi.fn(),
  registerNeedsInputCategories: vi.fn(),
  getLanguagePickerBridge: vi.fn(),
  setLanguagePickerBridge: vi.fn(),
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
vi.mock('@/i18n/direction-attempt', () => ({
  writeDirectionAttemptAsync: mocks.writeDirectionAttemptAsync,
  readDirectionAttemptAsync: mocks.readDirectionAttemptAsync,
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  setLanguagePreferenceAsync: mocks.setLanguagePreferenceAsync,
  getLanguagePreference: mocks.getLanguagePreference,
}));
vi.mock('@/lib/intl-cache', () => ({ prewarmIntl: mocks.prewarmIntl }));
vi.mock('@/lib/notifications', () => ({
  renameAndroidNotificationChannels: mocks.renameAndroidNotificationChannels,
}));
vi.mock('@/lib/notification-actions', () => ({
  registerNeedsInputCategories: mocks.registerNeedsInputCategories,
}));
vi.mock('@/lib/picker-bridge', () => ({
  getLanguagePickerBridge: mocks.getLanguagePickerBridge,
  setLanguagePickerBridge: mocks.setLanguagePickerBridge,
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
    mocks.writeDirectionAttemptAsync.mockReset().mockResolvedValue(true);
    mocks.readDirectionAttemptAsync.mockReset().mockResolvedValue(null);
    mocks.syncRtl.mockReset().mockReturnValue(false);
    mocks.i18nManager.isRTL = false;
    mocks.preference = 'device';
    mocks.getLanguagePreference.mockImplementation(() => mocks.preference);
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

    // The relaunch is recorded before it starts, so the cold start it comes
    // back to knows the direction was already attempted for this language.
    expect(mocks.writeDirectionAttemptAsync).toHaveBeenCalledWith('ar');

    // The reload tears this JS context down; the relaunched app registers the
    // categories in prepareLanguage after applying the stored language.
    expect(mocks.registerNeedsInputCategories).not.toHaveBeenCalled();
    expect(mocks.renameAndroidNotificationChannels).not.toHaveBeenCalled();
  });

  it('skips the relaunch when the attempt-record write fails', async () => {
    mocks.syncRtl.mockReturnValue(true);
    mocks.writeDirectionAttemptAsync.mockResolvedValue(false);

    await expect(applyLanguagePreference('ar', 'ar', 'login')).resolves.toEqual({
      kind: 'restart-skipped',
    });

    // Without the record a relaunch that did not take the direction would
    // repeat on every launch, so neither the direction nor the reload runs.
    expect(mocks.syncRtl).not.toHaveBeenCalled();
    expect(mocks.reloadAppAsync).not.toHaveBeenCalled();
  });

  it('leaves the relaunch guarded when the running app already attempted it', async () => {
    mocks.syncRtl.mockReturnValue(true);
    mocks.readDirectionAttemptAsync.mockResolvedValue('ar');

    await expect(applyDeviceLanguage('ar')).resolves.toEqual({
      kind: 'restart-guarded',
    });

    // The record names the language the last launch relaunched for: forcing it
    // again would loop through the retry screen while the platform keeps
    // answering with the previous direction. No direction or reload runs.
    expect(mocks.writeDirectionAttemptAsync).not.toHaveBeenCalled();
    expect(mocks.syncRtl).not.toHaveBeenCalled();
    expect(mocks.reloadAppAsync).not.toHaveBeenCalled();
  });

  it('relaunches for a different language than the recorded attempt', async () => {
    mocks.syncRtl.mockReturnValue(true);
    mocks.readDirectionAttemptAsync.mockResolvedValue('he');

    await expect(applyDeviceLanguage('ar')).resolves.toEqual({
      kind: 'restarting-rtl',
    });

    // A different language's attempt never counts for this one.
    expect(mocks.writeDirectionAttemptAsync).toHaveBeenCalledWith('ar');
    expect(mocks.syncRtl).toHaveBeenCalledWith('ar');
    expect(mocks.reloadAppAsync).toHaveBeenCalled();
  });

  it('never reads the attempt record for a manual pick, so its Retry can win', async () => {
    mocks.syncRtl.mockReturnValue(true);
    mocks.readDirectionAttemptAsync.mockResolvedValue('ar');

    await expect(applyLanguagePreference('ar', 'ar', 'login')).resolves.toEqual({
      kind: 'restarting-rtl',
    });

    // The person asking again is exactly the input the automatic guard
    // protects: the manual apply relaunches whatever the record names, and the
    // record write is what keeps the cold start from looping.
    expect(mocks.writeDirectionAttemptAsync).toHaveBeenCalledWith('ar');
    expect(mocks.syncRtl).toHaveBeenCalledWith('ar');
    expect(mocks.reloadAppAsync).toHaveBeenCalled();
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

  it('reports a catalog read that i18next swallowed instead of applied-ltr', async () => {
    // The lazy backend hands a read failure to i18next, which records it and
    // resolves, so the swallowed failure must be read off the bundle set.
    // The production call awaits the promise, never the TFunction value it
    // returns, so an undefined resolve keeps the spy's real signature.
    const changeLanguageSpy = vi
      .spyOn(i18n, 'changeLanguage')
      .mockResolvedValueOnce(undefined as never);
    const hasBundleSpy = vi.spyOn(i18n, 'hasResourceBundle').mockReturnValueOnce(false);

    await expect(applyLanguagePreference('es', 'es', 'login')).resolves.toEqual({
      kind: 'catalog-failed',
    });

    expect(mocks.registerNeedsInputCategories).not.toHaveBeenCalled();
    changeLanguageSpy.mockRestore();
    hasBundleSpy.mockRestore();
  });
});

describe('restorePickedLanguage', () => {
  beforeEach(async () => {
    mocks.renameAndroidNotificationChannels.mockReset().mockResolvedValue(undefined);
    mocks.registerNeedsInputCategories.mockReset().mockResolvedValue(undefined);
    mocks.i18nManager.isRTL = false;
    mocks.preference = 'device';
    mocks.getLanguagePreference.mockImplementation(() => mocks.preference);
    await i18n.changeLanguage('en');
  });

  it('restores the pick the follow lost the race to', async () => {
    // The follow landed the device language (`fr`) while the person's pick
    // (`es`) had already been persisted: the catalog must go back to the pick.
    await i18n.changeLanguage('fr');
    mocks.preference = 'es';

    await expect(restorePickedLanguage()).resolves.toEqual({ kind: 'applied-ltr' });

    expect(i18n.resolvedLanguage).toBe('es');
    expect(mocks.renameAndroidNotificationChannels).toHaveBeenCalledTimes(1);
    expect(mocks.registerNeedsInputCategories).toHaveBeenCalledTimes(1);
  });

  it('restores nothing while the preference is the device language', async () => {
    mocks.preference = 'device';
    await i18n.changeLanguage('fr');

    await expect(restorePickedLanguage()).resolves.toBeNull();

    expect(i18n.resolvedLanguage).toBe('fr');
  });

  it('restores nothing for a pick that changes the direction', async () => {
    // An RTL pick persists and reloads by itself; swapping the catalog in place
    // would paint it into the old LTR direction.
    mocks.i18nManager.isRTL = false;
    mocks.preference = 'ar';
    await i18n.changeLanguage('fr');

    await expect(restorePickedLanguage()).resolves.toBeNull();

    expect(i18n.resolvedLanguage).toBe('fr');
  });

  it('reports a pick whose catalog failed', async () => {
    await i18n.changeLanguage('fr');
    mocks.preference = 'es';
    const changeLanguageSpy = vi
      .spyOn(i18n, 'changeLanguage')
      .mockResolvedValueOnce(undefined as never);
    const hasBundleSpy = vi.spyOn(i18n, 'hasResourceBundle').mockReturnValueOnce(false);

    await expect(restorePickedLanguage()).resolves.toEqual({ kind: 'catalog-failed' });

    changeLanguageSpy.mockRestore();
    hasBundleSpy.mockRestore();
  });
});

describe('automatic relaunch — login draft flush', () => {
  beforeEach(async () => {
    mocks.setLanguagePreferenceAsync.mockReset().mockResolvedValue(true);
    mocks.renameAndroidNotificationChannels.mockReset().mockResolvedValue(undefined);
    mocks.registerNeedsInputCategories.mockReset().mockResolvedValue(undefined);
    mocks.reloadAppAsync.mockReset().mockResolvedValue(undefined);
    mocks.writeLanguageReturnTarget.mockReset().mockResolvedValue(undefined);
    mocks.writeDirectionAttemptAsync.mockReset().mockResolvedValue(true);
    mocks.readDirectionAttemptAsync.mockReset().mockResolvedValue(null);
    mocks.syncRtl.mockReset();
    mocks.i18nManager.isRTL = false;
    mocks.preference = 'device';
    mocks.getLanguagePreference.mockImplementation(() => mocks.preference);
    mocks.getLanguagePickerBridge.mockReset().mockReturnValue(null);
    await i18n.changeLanguage('en');
  });

  it('flushes the registered draft write before the automatic relaunch', async () => {
    mocks.syncRtl.mockReturnValue(false);
    const flushes: string[] = [];
    const reloadsWhenFlushed: number[] = [];
    mocks.getLanguagePickerBridge.mockReturnValue({
      beforeReload: () => {
        flushes.push('flush');
        reloadsWhenFlushed.push(mocks.reloadAppAsync.mock.calls.length);
        return Promise.resolve();
      },
    });

    await expect(applyDeviceLanguage('ar')).resolves.toEqual({ kind: 'restarting-rtl' });

    expect(flushes).toHaveLength(1);
    // The flush finished before the reload started: the drafts it writes live
    // in the same JS context the reload discards.
    expect(reloadsWhenFlushed).toEqual([0]);
    expect(mocks.reloadAppAsync).toHaveBeenCalledTimes(1);
  });

  it('does not flush for a manual pick whose own beforeReload handles it', async () => {
    mocks.syncRtl.mockReturnValue(true);
    const flushes: string[] = [];
    mocks.getLanguagePickerBridge.mockReturnValue({
      beforeReload: () => {
        flushes.push('flush');
        return Promise.resolve();
      },
    });
    let manualFlushRan = false;

    await expect(
      applyLanguagePreference('ar', 'ar', 'login', () => {
        manualFlushRan = true;
        return Promise.resolve();
      })
    ).resolves.toEqual({ kind: 'restarting-rtl' });

    // The manual path runs the flush the picker handed it; flushing the
    // registered bridge too would persist the same drafts twice.
    expect(flushes).toEqual([]);
    expect(manualFlushRan).toBe(true);
  });

  it('a throwing bridge flush still lets the automatic relaunch run', async () => {
    mocks.syncRtl.mockReturnValue(false);
    mocks.getLanguagePickerBridge.mockReturnValue({
      beforeReload: () => Promise.reject(new Error('draft write failed')),
    });

    await expect(applyDeviceLanguage('ar')).resolves.toEqual({ kind: 'restarting-rtl' });

    expect(mocks.reloadAppAsync).toHaveBeenCalledTimes(1);
  });
});
