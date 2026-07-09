import { describe, expect, it } from 'vitest';

import {
  getSettingsBackGuardOptions,
  getSettingsDirtyState,
} from '@/components/security-agent/settings-screen-state';
import { type SecurityAgentConfig } from '@/lib/security-agent';

describe('getSettingsDirtyState', () => {
  const config = {
    selectedRepositoryIds: [1, 2],
    slaCriticalDays: 15,
  } satisfies Partial<SecurityAgentConfig>;

  it('is clean when the patch matches the loaded config', () => {
    expect(getSettingsDirtyState(config, { selectedRepositoryIds: [1, 2] }, true)).toBe('clean');
  });

  it('is dirty when the selected-repository array order changes, even with the same members', () => {
    expect(getSettingsDirtyState(config, { selectedRepositoryIds: [2, 1] }, true)).toBe(
      'dirty-valid'
    );
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
