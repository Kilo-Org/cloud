import {
  isSecurityConfigPatchDirty,
  type SecurityAgentConfig,
  type SecurityAgentConfigPatch,
} from '@/lib/security-agent';

/**
 * Pure classification of a settings screen's local edits against the loaded
 * config. `dirty-invalid` covers edits that fail screen-specific validation
 * (e.g. an empty repository selection, an out-of-range SLA day count) — the
 * screen supplies `valid` since only it knows its own validation rule.
 */
type SettingsDirtyState = 'clean' | 'dirty-valid' | 'dirty-invalid';

const MIN_SLA_DAYS = 1;
const MAX_SLA_DAYS = 365;

/**
 * Parses a raw numeric `TextInput` string into a whole-day count, or `NaN`
 * if it isn't one — shared by the notification screen's SLA warning lead
 * time and the SLA screen's four severity day thresholds, all validated as
 * 1-365 whole days.
 */
export function parseDayCount(raw: string): number {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

export function isValidDayCount(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_SLA_DAYS && value <= MAX_SLA_DAYS;
}

export function getSettingsDirtyState(
  config: Partial<SecurityAgentConfig>,
  patch: SecurityAgentConfigPatch,
  valid: boolean
): SettingsDirtyState {
  if (!isSecurityConfigPatchDirty(config, patch)) {
    return 'clean';
  }
  return valid ? 'dirty-valid' : 'dirty-invalid';
}

type SettingsBackGuardOption = 'save' | 'discard' | 'keep-editing';

/**
 * Which buttons a back-navigation confirmation alert should offer. A clean
 * screen returns no options — callers should let navigation proceed with no
 * alert at all. A dirty-invalid screen omits "save": there is nothing valid
 * to persist, so the user can only discard or keep editing.
 */
export function getSettingsBackGuardOptions(
  dirtyState: SettingsDirtyState
): SettingsBackGuardOption[] {
  if (dirtyState === 'clean') {
    return [];
  }
  if (dirtyState === 'dirty-invalid') {
    return ['discard', 'keep-editing'];
  }
  return ['save', 'discard', 'keep-editing'];
}
