import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIDEBAR_PREFERENCES,
  SIDEBAR_PREFERENCES_STORAGE_KEY,
  normalizeSidebarPreferences,
} from './storage';

describe('sidebar storage', () => {
  it('uses a local WXT storage key for sidebar preferences', () => {
    expect.assertions(1);
    expect(SIDEBAR_PREFERENCES_STORAGE_KEY).toBe('local:sidebarPreferences');
  });

  it('keeps the sidebar closed by default', () => {
    expect.assertions(1);
    expect(DEFAULT_SIDEBAR_PREFERENCES).toStrictEqual({ isOpen: false });
  });

  it('normalizes valid persisted sidebar preferences', () => {
    expect.assertions(1);
    expect(normalizeSidebarPreferences({ isOpen: true })).toStrictEqual({
      isOpen: true,
    });
  });

  it('falls back to defaults for invalid persisted values', () => {
    expect.assertions(2);
    expect(normalizeSidebarPreferences()).toStrictEqual(DEFAULT_SIDEBAR_PREFERENCES);
    expect(normalizeSidebarPreferences({ isOpen: 'yes' })).toStrictEqual(
      DEFAULT_SIDEBAR_PREFERENCES
    );
  });
});
