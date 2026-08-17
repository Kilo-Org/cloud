import { describe, expect, it, vi } from 'vitest';

import { radioItemA11y } from './radio-group';

// The helper is a pure function; mock react-native so the node test never
// parses RN's Flow-typed sources (same pattern as diff-font-metrics.test.ts).
vi.mock('react-native', () => ({ View: 'View' }));

describe('radioItemA11y', () => {
  it('defaults disabled and busy to false', () => {
    expect(radioItemA11y({ label: 'Squash', checked: false })).toEqual({
      accessibilityRole: 'radio',
      accessibilityLabel: 'Squash',
      accessibilityState: { checked: false, disabled: false, busy: false },
    });
  });

  it('keeps label and role intact with disabled and busy set', () => {
    expect(radioItemA11y({ label: 'Merge', checked: false, disabled: true, busy: true })).toEqual({
      accessibilityRole: 'radio',
      accessibilityLabel: 'Merge',
      accessibilityState: { checked: false, disabled: true, busy: true },
    });
  });
});
