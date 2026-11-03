import { describe, expect, it, vi } from 'vitest';

import { tabEntryA11y } from './tab-entry';

// The mapping is a pure function; mock react-native so the node test never
// parses RN's Flow-typed sources (same pattern as selectable-row.test.ts).
const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
vi.mock('react-native', () => ({ Platform: platform }));

describe('tabEntryA11y', () => {
  it('keeps the Android tab role with the selected state', () => {
    platform.OS = 'android';
    expect(tabEntryA11y({ selected: true })).toEqual({
      role: 'tab',
      accessibilityState: { selected: true },
    });
    expect(tabEntryA11y({ selected: false })).toEqual({
      role: 'tab',
      accessibilityState: { selected: false },
    });
  });

  it('types the entry as a selected button on iOS, which gives the tab role no trait', () => {
    platform.OS = 'ios';
    expect(tabEntryA11y({ selected: true })).toEqual({
      role: 'button',
      accessibilityState: { selected: true },
    });
    expect(tabEntryA11y({ selected: false })).toEqual({
      role: 'button',
      accessibilityState: { selected: false },
    });
  });

  it('adds disabled only when the caller passes it', () => {
    platform.OS = 'android';
    expect(tabEntryA11y({ selected: false })).not.toHaveProperty('accessibilityState.disabled');
    expect(tabEntryA11y({ selected: true, disabled: true })).toEqual({
      role: 'tab',
      accessibilityState: { selected: true, disabled: true },
    });
  });
});
