import { describe, expect, it, vi } from 'vitest';

import { selectableRowA11y } from './selectable-row';

// The mapping is a pure function; mock react-native so the node test never
// parses RN's Flow-typed sources (same pattern as radio-group.test.ts).
const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
vi.mock('react-native', () => ({ Platform: platform }));

describe('selectableRowA11y', () => {
  it('keeps the Android checkbox role and checked state on a multi-select row', () => {
    platform.OS = 'android';
    expect(selectableRowA11y({ multi: true, selected: true })).toEqual({
      accessibilityRole: 'checkbox',
      accessibilityState: { checked: true },
    });
  });

  it('keeps the Android radio role and checked state on a single-choice row', () => {
    platform.OS = 'android';
    expect(selectableRowA11y({ multi: false, selected: false })).toEqual({
      accessibilityRole: 'radio',
      accessibilityState: { checked: false },
    });
  });

  it('maps both row kinds onto a selected button on iOS', () => {
    platform.OS = 'ios';
    expect(selectableRowA11y({ multi: true, selected: true })).toEqual({
      accessibilityRole: 'button',
      accessibilityState: { selected: true },
    });
    expect(selectableRowA11y({ multi: false, selected: false })).toEqual({
      accessibilityRole: 'button',
      accessibilityState: { selected: false },
    });
  });

  it('adds disabled and busy only when the caller passes them', () => {
    platform.OS = 'android';
    expect(selectableRowA11y({ multi: true, selected: false })).not.toHaveProperty(
      'accessibilityState.disabled'
    );
    expect(
      selectableRowA11y({ multi: true, selected: false, disabled: true, busy: false })
    ).toEqual({
      accessibilityRole: 'checkbox',
      accessibilityState: { checked: false, disabled: true, busy: false },
    });
  });
});
