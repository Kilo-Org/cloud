import { describe, expect, test } from '@jest/globals';
import { matchesBuiltInModeState } from './EditModeForm';
import { DEFAULT_MODES } from './default-modes';
import type { ModeFormData } from './ModeForm';

function codeModeForm(overrides: Partial<ModeFormData> = {}): ModeFormData {
  const codeMode = DEFAULT_MODES.find(mode => mode.slug === 'code')!;

  return {
    name: codeMode.name,
    slug: codeMode.slug,
    roleDefinition: codeMode.config.roleDefinition || '',
    description: codeMode.config.description || '',
    whenToUse: codeMode.config.whenToUse || '',
    groups: [...(codeMode.config.groups || [])],
    customInstructions: codeMode.config.customInstructions || '',
    ...overrides,
  };
}

describe('matchesBuiltInModeState', () => {
  test('returns true for a built-in mode state with reordered groups', () => {
    const formData = codeModeForm({ groups: [...codeModeForm().groups].reverse() });

    expect(matchesBuiltInModeState(formData, 'code')).toBe(true);
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
