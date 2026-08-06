// Hidden root-route accessibility contract (P2-C-18a). The root layout keeps
// the `<Slot />` mounted while it redirects between auth/consent/app gates so
// Expo Router's navigation tree stays initialised; `opacity-0` + `pointerEvents`
// only hid the tree visually and from touch, not from screen readers. These
// props remove the hidden wrapper from both accessibility trees (iOS via
// `accessibilityElementsHidden`, Android via `importantForAccessibility`) and
// restore it when the route is shown.

export type HiddenSlotA11yProps = {
  readonly accessibilityElementsHidden: boolean;
  readonly importantForAccessibility: 'auto' | 'no-hide-descendants';
};

/**
 * Accessibility props for the hidden root-route wrapper.
 *
 * When `hidden` is true the wrapper leaves both accessibility trees
 * (`no-hide-descendants` on Android, `accessibilityElementsHidden` on iOS);
 * when false both are restored to their default exposure.
 */
export function hiddenSlotA11yProps(hidden: boolean): HiddenSlotA11yProps {
  return hidden
    ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }
    : { accessibilityElementsHidden: false, importantForAccessibility: 'auto' };
}
