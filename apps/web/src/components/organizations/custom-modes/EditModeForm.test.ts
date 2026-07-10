import { describe, expect, test } from '@jest/globals';
import { matchesBuiltInModeState } from './EditModeForm';
import { DEFAULT_MODES } from './default-modes';
import type { ModeFormData } from './ModeForm';

function builtInModeForm(slug: string, overrides: Partial<ModeFormData> = {}): ModeFormData {
  const mode = DEFAULT_MODES.find(defaultMode => defaultMode.slug === slug)!;

  return {
    name: mode.name,
    slug: mode.slug,
    roleDefinition: mode.config.roleDefinition || '',
    description: mode.config.description || '',
    whenToUse: mode.config.whenToUse || '',
    groups: [...(mode.config.groups || [])],
    customInstructions: mode.config.customInstructions || '',
    ...overrides,
  };
}

function codeModeForm(overrides: Partial<ModeFormData> = {}): ModeFormData {
  return builtInModeForm('code', overrides);
}

describe('matchesBuiltInModeState', () => {
  test('returns true for a built-in mode state with reordered groups', () => {
    const formData = codeModeForm({ groups: [...codeModeForm().groups].reverse() });

    expect(matchesBuiltInModeState(formData, 'code')).toBe(true);
  });

  test('returns true for a built-in mode state with reordered configured groups', () => {
    const formData = builtInModeForm('architect', {
      groups: [...builtInModeForm('architect').groups].reverse(),
    });

    expect(matchesBuiltInModeState(formData, 'architect')).toBe(true);
  });

  test('returns false when another customization remains', () => {
    const formData = codeModeForm({ description: 'Customized description' });

    expect(matchesBuiltInModeState(formData, 'code')).toBe(false);
  });

  test('returns false when the mode name was changed', () => {
    const formData = codeModeForm({ name: 'Renamed Code' });

    expect(matchesBuiltInModeState(formData, 'code')).toBe(false);
  });
});
