import { describe, expect, it } from 'vitest';

import { hiddenSlotA11yProps } from './hidden-route';

/**
 * Feature C — hidden root-route semantics.
 *
 * The helper is pure presentation for the root layout wrapper, so the feature
 * states are:
 * - hidden: the wrapper leaves both accessibility trees — iOS
 *   `accessibilityElementsHidden` true, Android `importantForAccessibility`
 *   `no-hide-descendants`.
 * - visible: both are restored to the default exposure (`false` / `auto`).
 */

describe('hiddenSlotA11yProps', () => {
  it('hides the wrapper from both accessibility trees when hidden', () => {
    expect(hiddenSlotA11yProps(true)).toEqual({
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
  });

  it('restores the default exposure when visible', () => {
    expect(hiddenSlotA11yProps(false)).toEqual({
      accessibilityElementsHidden: false,
      importantForAccessibility: 'auto',
    });
  });
});
