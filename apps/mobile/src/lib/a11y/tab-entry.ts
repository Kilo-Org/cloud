import { type AccessibilityState, Platform } from 'react-native';

type TabEntryOptions = {
  selected: boolean;
  disabled?: boolean;
};

type TabEntryA11y = {
  role: 'button' | 'tab';
  accessibilityState: AccessibilityState;
};

/**
 * One entry of a single-select strip, as each OS types it.
 *
 * React Native derives the iOS control trait from the resolved role, and the
 * role table has no `tab` entry (AccessibilityProps derives the traits through
 * accessibilityPropsConversions, whose string table ends in `None`; the Fabric
 * view component says so outright), so VoiceOver reads such an entry as static
 * text and only `selected` marks the active one. The button role carries the
 * interactive trait iOS needs. Android keeps `tab`, whose role description
 * TalkBack appends to the entry, beside the `tablist` container's.
 */
export function tabEntryA11y({ selected, disabled }: Readonly<TabEntryOptions>): TabEntryA11y {
  const accessibilityState: AccessibilityState = { selected };
  if (disabled !== undefined) {
    accessibilityState.disabled = disabled;
  }
  return { role: Platform.OS === 'ios' ? 'button' : 'tab', accessibilityState };
}
