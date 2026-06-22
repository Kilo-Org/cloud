export const SIDEBAR_PREFERENCES_STORAGE_KEY = 'local:sidebarPreferences';

export interface SidebarPreferences {
  readonly isOpen: boolean;
}

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  isOpen: false,
};

export const normalizeSidebarPreferences = (value?: unknown): SidebarPreferences => {
  if (
    typeof value === 'object' &&
    value !== null &&
    'isOpen' in value &&
    typeof value.isOpen === 'boolean'
  ) {
    return {
      isOpen: value.isOpen,
    };
  }

  return DEFAULT_SIDEBAR_PREFERENCES;
};
