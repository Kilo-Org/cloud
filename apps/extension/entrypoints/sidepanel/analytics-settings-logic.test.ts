import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_SETTINGS_SAVE_ERROR,
  FIREFOX_USAGE_DATA_BLOCKED_HINT,
  applyAnalyticsSettingsLoaded,
  beginAnalyticsSettingsFlip,
  completeAnalyticsSettingsFlip,
  createInitialAnalyticsSettingsState,
  failAnalyticsSettingsFlip,
  isAnalyticsSettingsInteractive,
  mapAnalyticsSettingsSaveRejection,
  resolveAnalyticsOptOutIdentity,
  shouldShowFirefoxUsageDataHint,
} from './analytics-settings-logic';

describe('analytics-settings-logic', () => {
  describe('happy path — load reflects persisted state', () => {
    it('starts in loading with checked true (enabled default)', () => {
      const state = createInitialAnalyticsSettingsState();
      expect(state.phase).toBe('loading');
      expect(state.checked).toBe(true);
      expect(state.errorMessage).toBeNull();
      expect(isAnalyticsSettingsInteractive(state)).toBe(false);
    });

    it('maps absent opt-out (false) to checked true / enabled', () => {
      const state = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: true,
        optedOut: false,
      });
      expect(state.phase).toBe('settled');
      expect(state.checked).toBe(true);
      expect(state.errorMessage).toBeNull();
      expect(isAnalyticsSettingsInteractive(state)).toBe(true);
    });

    it('maps optedOut true to checked false / disabled', () => {
      const state = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: true,
        optedOut: true,
      });
      expect(state.phase).toBe('settled');
      expect(state.checked).toBe(false);
      expect(state.errorMessage).toBeNull();
    });
  });

  describe('happy path — flip transitions and persist args', () => {
    it('flip from enabled starts saving with optedOut true', () => {
      const settled = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: true,
        optedOut: false,
      });
      const started = beginAnalyticsSettingsFlip(settled);
      expect(started).not.toBeNull();
      expect(started?.nextChecked).toBe(false);
      expect(started?.optedOut).toBe(true);
      expect(started?.priorChecked).toBe(true);
      expect(started?.state.phase).toBe('saving');
    });

    it('opt-out flip does not require identity', () => {
      expect(resolveAnalyticsOptOutIdentity(true, 'user@kilo.ai')).toBeUndefined();
      const settled = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: true,
        optedOut: false,
      });
      const started = beginAnalyticsSettingsFlip(settled);
      expect(started?.state.checked).toBe(false);
      expect(started?.state.errorMessage).toBeNull();
    });

    it('flip from disabled re-enables with email identity', () => {
      const settled = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: true,
        optedOut: true,
      });
      const started = beginAnalyticsSettingsFlip(settled);
      expect(started).not.toBeNull();
      expect(started?.nextChecked).toBe(true);
      expect(started?.optedOut).toBe(false);
      expect(started?.priorChecked).toBe(false);
      expect(resolveAnalyticsOptOutIdentity(false, 'user@kilo.ai')).toStrictEqual({
        email: 'user@kilo.ai',
      });
    });

    it('complete settles at the optimistic checked value', () => {
      const settled = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: true,
        optedOut: false,
      });
      const started = beginAnalyticsSettingsFlip(settled);
      expect(started).not.toBeNull();
      const done = completeAnalyticsSettingsFlip(started!.state);
      expect(done.phase).toBe('settled');
      expect(done.checked).toBe(false);
      expect(done.errorMessage).toBeNull();
      expect(done.priorChecked).toBeNull();
    });

    it('ignores flip while loading or saving', () => {
      expect(beginAnalyticsSettingsFlip(createInitialAnalyticsSettingsState())).toBeNull();

      const settled = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: true,
        optedOut: false,
      });
      const started = beginAnalyticsSettingsFlip(settled);
      expect(started).not.toBeNull();
      expect(beginAnalyticsSettingsFlip(started!.state)).toBeNull();
    });
  });

  describe('unhappy retryable — storage rejection', () => {
    it('reverts to prior position with exact error message', () => {
      const settled = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: true,
        optedOut: false,
      });
      const started = beginAnalyticsSettingsFlip(settled);
      expect(started).not.toBeNull();

      const failed = failAnalyticsSettingsFlip(started!.state, started!.priorChecked);
      expect(failed.phase).toBe('error');
      expect(failed.checked).toBe(true);
      expect(failed.errorMessage).toBe(ANALYTICS_SETTINGS_SAVE_ERROR);
      expect(failed.errorMessage).toBe("Couldn't save the setting. Try again.");
    });

    it('error state remains interactive for retry CTA', () => {
      const settled = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: true,
        optedOut: false,
      });
      const started = beginAnalyticsSettingsFlip(settled);
      const failed = failAnalyticsSettingsFlip(started!.state, started!.priorChecked);
      expect(isAnalyticsSettingsInteractive(failed)).toBe(true);
    });

    it('subsequent flip retries and clears the error', () => {
      const settled = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: true,
        optedOut: false,
      });
      const first = beginAnalyticsSettingsFlip(settled);
      const failed = failAnalyticsSettingsFlip(first!.state, first!.priorChecked);
      expect(failed.errorMessage).toBe(ANALYTICS_SETTINGS_SAVE_ERROR);

      const retry = beginAnalyticsSettingsFlip(failed);
      expect(retry).not.toBeNull();
      expect(retry?.state.phase).toBe('saving');
      expect(retry?.state.errorMessage).toBeNull();
      expect(retry?.optedOut).toBe(true);
    });
  });

  describe('unhappy non-retryable — structurally impossible', () => {
    it('maps every rejection to the retryable save error', () => {
      expect(mapAnalyticsSettingsSaveRejection(new Error('quota'))).toBe(
        ANALYTICS_SETTINGS_SAVE_ERROR
      );
      expect(mapAnalyticsSettingsSaveRejection('string reject')).toBe(
        ANALYTICS_SETTINGS_SAVE_ERROR
      );
      expect(mapAnalyticsSettingsSaveRejection(null)).toBe(ANALYTICS_SETTINGS_SAVE_ERROR);
      expect(mapAnalyticsSettingsSaveRejection({ code: 42 })).toBe(ANALYTICS_SETTINGS_SAVE_ERROR);
    });
  });

  describe('firefox hint visibility', () => {
    it('hides the hint when usage data is granted', () => {
      expect(shouldShowFirefoxUsageDataHint(true)).toBe(false);
      const state = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: true,
        optedOut: false,
      });
      expect(shouldShowFirefoxUsageDataHint(state.firefoxUsageDataGranted)).toBe(false);
    });

    it('shows the hint when usage data is not granted', () => {
      expect(shouldShowFirefoxUsageDataHint(false)).toBe(true);
      const state = applyAnalyticsSettingsLoaded({
        firefoxUsageDataGranted: false,
        optedOut: false,
      });
      expect(shouldShowFirefoxUsageDataHint(state.firefoxUsageDataGranted)).toBe(true);
      expect(FIREFOX_USAGE_DATA_BLOCKED_HINT.length).toBeGreaterThan(0);
    });
  });

  describe('opt-out identity resolution', () => {
    it('returns undefined when opting out even if email is present', () => {
      expect(resolveAnalyticsOptOutIdentity(true, 'user@kilo.ai')).toBeUndefined();
    });

    it('returns undefined when re-enabling without an email', () => {
      expect(resolveAnalyticsOptOutIdentity(false)).toBeUndefined();
      expect(resolveAnalyticsOptOutIdentity(false, '')).toBeUndefined();
      expect(resolveAnalyticsOptOutIdentity(false, '   ')).toBeUndefined();
    });

    it('returns email identity when re-enabling with email', () => {
      expect(resolveAnalyticsOptOutIdentity(false, 'user@kilo.ai')).toStrictEqual({
        email: 'user@kilo.ai',
      });
    });
  });
});
