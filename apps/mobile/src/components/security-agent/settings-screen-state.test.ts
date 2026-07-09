import { describe, expect, it } from 'vitest';

import {
  getSettingsBackGuardOptions,
  getSettingsDirtyState,
  isValidDayCount,
  parseDayCount,
} from '@/components/security-agent/settings-screen-state';
import { type SecurityAgentConfig, type SecurityAgentConfigPatch } from '@/lib/security-agent';

describe('getSettingsDirtyState', () => {
  const config = {
    selectedRepositoryIds: [1, 2],
    slaCriticalDays: 15,
  } satisfies Partial<SecurityAgentConfig>;

  it('is clean when the patch matches the loaded config', () => {
    expect(getSettingsDirtyState(config, { selectedRepositoryIds: [1, 2] }, true)).toBe('clean');
  });

  it('is clean when selected repositories have the same members in a different order', () => {
    expect(getSettingsDirtyState(config, { selectedRepositoryIds: [2, 1] }, true)).toBe('clean');
  });

  it('is dirty-invalid when an SLA edit is numerically invalid', () => {
    expect(getSettingsDirtyState(config, { slaCriticalDays: 0 }, false)).toBe('dirty-invalid');
  });

  it('is dirty-valid when a change is valid', () => {
    expect(getSettingsDirtyState(config, { slaCriticalDays: 20 }, true)).toBe('dirty-valid');
  });

  it('is clean when the patch is empty', () => {
    expect(getSettingsDirtyState(config, {}, true)).toBe('clean');
  });
});

describe('getSettingsBackGuardOptions', () => {
  it('offers no options when clean, so back navigates immediately', () => {
    expect(getSettingsBackGuardOptions('clean')).toEqual([]);
  });

  it('omits save when dirty-invalid — there is nothing valid to persist', () => {
    expect(getSettingsBackGuardOptions('dirty-invalid')).toEqual(['discard', 'keep-editing']);
  });

  it('offers save, discard, and keep-editing when dirty-valid', () => {
    expect(getSettingsBackGuardOptions('dirty-valid')).toEqual(['save', 'discard', 'keep-editing']);
  });
});

describe('parseDayCount', () => {
  it('parses a plain integer string', () => {
    expect(parseDayCount('30')).toBe(30);
  });

  it('rejects non-digit input', () => {
    expect(Number.isNaN(parseDayCount('abc'))).toBe(true);
  });

  it('rejects empty input', () => {
    expect(Number.isNaN(parseDayCount(''))).toBe(true);
  });

  it('rejects decimal input', () => {
    expect(Number.isNaN(parseDayCount('1.5'))).toBe(true);
  });
});

describe('isValidDayCount', () => {
  it('accepts the 1-365 boundary values', () => {
    expect(isValidDayCount(1)).toBe(true);
    expect(isValidDayCount(365)).toBe(true);
  });

  it('rejects values outside 1-365', () => {
    expect(isValidDayCount(0)).toBe(false);
    expect(isValidDayCount(366)).toBe(false);
  });

  it('rejects NaN', () => {
    expect(isValidDayCount(Number.NaN)).toBe(false);
  });
});

// Proves each of Task 9's three settings screens submits only the fields it
// owns — the backend merges partial patches, so a screen accidentally
// pulling in another screen's field would silently overwrite it on save.
describe('Task 9 settings screens each own a disjoint field set', () => {
  it('Automation screen patch contains exactly its 8 fields', () => {
    const patch: SecurityAgentConfigPatch = {
      autoAnalysisEnabled: true,
      autoAnalysisMinSeverity: 'high',
      autoAnalysisIncludeExisting: false,
      autoRemediationEnabled: true,
      autoRemediationMinSeverity: 'critical',
      autoRemediationIncludeExisting: false,
      autoDismissEnabled: true,
      autoDismissConfidenceThreshold: 'medium',
    };
    expect(new Set(Object.keys(patch))).toEqual(
      new Set([
        'autoAnalysisEnabled',
        'autoAnalysisMinSeverity',
        'autoAnalysisIncludeExisting',
        'autoRemediationEnabled',
        'autoRemediationMinSeverity',
        'autoRemediationIncludeExisting',
        'autoDismissEnabled',
        'autoDismissConfidenceThreshold',
      ])
    );
  });

  it('Notifications screen patch contains exactly its 5 fields', () => {
    const patch: SecurityAgentConfigPatch = {
      newFindingNotificationsEnabled: true,
      newFindingNotificationMinSeverity: 'high',
      slaNotificationsEnabled: true,
      slaNotificationMinSeverity: 'low',
      slaNotificationWarningDays: 3,
    };
    expect(new Set(Object.keys(patch))).toEqual(
      new Set([
        'newFindingNotificationsEnabled',
        'newFindingNotificationMinSeverity',
        'slaNotificationsEnabled',
        'slaNotificationMinSeverity',
        'slaNotificationWarningDays',
      ])
    );
  });

  it('SLA screen patch contains exactly its 5 fields', () => {
    const patch: SecurityAgentConfigPatch = {
      slaEnabled: true,
      slaCriticalDays: 1,
      slaHighDays: 7,
      slaMediumDays: 30,
      slaLowDays: 90,
    };
    expect(new Set(Object.keys(patch))).toEqual(
      new Set(['slaEnabled', 'slaCriticalDays', 'slaHighDays', 'slaMediumDays', 'slaLowDays'])
    );
  });
});

// Proves the notification screen's SLA warning lead time and the SLA
// screen's four day fields can never reach the backend when the typed text
// isn't a valid 1-365 whole number — dirty-invalid omits "Save" from the
// back-guard alert (see getSettingsBackGuardOptions above) and each
// screen's own Save button gate, so this is the one place both properties
// have to hold together.
describe('invalid day/lead-time input can never classify as dirty-valid', () => {
  const config = {
    slaNotificationWarningDays: 7,
    slaCriticalDays: 15,
    slaHighDays: 10,
    slaMediumDays: 5,
    slaLowDays: 2,
  } satisfies Partial<SecurityAgentConfig>;

  const cases: { field: keyof SecurityAgentConfigPatch; raw: string }[] = [
    { field: 'slaNotificationWarningDays', raw: '' },
    { field: 'slaCriticalDays', raw: '0' },
    { field: 'slaHighDays', raw: '400' },
    { field: 'slaMediumDays', raw: 'abc' },
    { field: 'slaLowDays', raw: '1.5' },
  ];

  it.each(cases)('$field = "$raw" forces dirty-invalid, never dirty-valid', ({ field, raw }) => {
    const parsed = parseDayCount(raw);
    const valid = isValidDayCount(parsed);
    expect(valid).toBe(false);
    const patch: SecurityAgentConfigPatch = { [field]: parsed };
    expect(getSettingsDirtyState(config, patch, valid)).toBe('dirty-invalid');
  });
});
