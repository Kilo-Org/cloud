// The profile Variables row must keep a long key's distinguishing suffix: keys
// in one profile share long prefixes, so React Native's default tail ellipsis
// made neighbouring rows look identical at a compact width.
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type VariableRow } from '@/components/profiles/profile-variables-model';
import { VariableRowView } from '@/components/profiles/profile-variables-rows';
import { renderWithProviders } from '@/test/render-with-providers';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({
  Eye: 'Eye',
  EyeOff: 'EyeOff',
  Lock: 'Lock',
  Trash2: 'Trash2',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));

/** Longer than a compact row's key column, as profile keys commonly are. */
const LONG_KEY = 'ROTATION_DRAFT_KEPT_R3';

const ROW: VariableRow = {
  key: LONG_KEY,
  value: '***',
  isSecret: true,
  maskedValue: '••••••••',
};

describe('variable row key truncation', () => {
  it('truncates the key in the middle so a shared prefix cannot hide the suffix', async () => {
    const mounted = await renderWithProviders(createElement(VariableRowView, { row: ROW }));
    const key = mounted.renderer.root.findAll(
      node => String(node.type) === 'Text' && node.props.children === LONG_KEY
    )[0];
    if (key === undefined) {
      throw new Error('The variable key did not mount as one text node');
    }
    expect(key.props.numberOfLines).toBe(1);
    expect(key.props.ellipsizeMode).toBe('middle');
  });
});
