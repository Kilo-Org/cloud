import { describe, expect, it, vi } from 'vitest';

import { radioItemA11y } from './radio-group';

// The helper is a pure function; mock react-native so the node test never
// parses RN's Flow-typed sources (same pattern as diff-font-metrics.test.ts).
vi.mock('react-native', () => ({ View: 'View' }));

describe('radioItemA11y', () => {
  it('returns the radio role and the item label', () => {
    expect(radioItemA11y({ label: 'Squash', checked: false })).toMatchObject({
      accessibilityRole: 'radio',
      accessibilityLabel: 'Squash',
    });
  });

  it('exposes checked=true when the option is selected', () => {
    expect(radioItemA11y({ label: 'Squash', checked: true }).accessibilityState.checked).toBe(true);
  });

  it('exposes checked=false when the option is not selected', () => {
    expect(radioItemA11y({ label: 'Squash', checked: false }).accessibilityState.checked).toBe(
      false
    );
  });

  it('defaults disabled and busy to false', () => {
    expect(radioItemA11y({ label: 'Squash', checked: false }).accessibilityState).toEqual({
      checked: false,
      disabled: false,
      busy: false,
    });
  });

  it('exposes disabled and busy when provided', () => {
    expect(
      radioItemA11y({ label: 'Squash', checked: true, disabled: true, busy: true })
        .accessibilityState
    ).toEqual({
      checked: true,
      disabled: true,
      busy: true,
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
