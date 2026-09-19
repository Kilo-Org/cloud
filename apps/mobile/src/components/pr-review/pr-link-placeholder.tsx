import { View } from 'react-native';

import { Text } from '@/components/ui/text';

/**
 * The visible placeholder for the PR-link field, drawn as one ellipsized line
 * on both platforms.
 *
 * A TextInput's native placeholder is not reliably single-line here. Android
 * renders the placeholder as the native EditText hint, and React Native never
 * marks a single-line input as single-line — it only clears the multiline
 * input-type flag — so a hint wider than the field lays out on a second line
 * that the one-line field clips (pr-review-home at font scale 2).
 * `numberOfLines` cannot stop it: the hint layout ignores it. iOS truncates its
 * own placeholder, but the field must render the same on both platforms, so
 * both draw this overlay and keep the native hint (transparent) for the
 * accessibility and digest text. That keeps the placeholder on one line at any
 * font scale or translation length on either platform.
 *
 * The overlay is hidden from assistive tech on both platforms by spelling the
 * one capability with each platform's prop: `accessibilityElementsHidden`
 * applies on iOS and `importantForAccessibility` on Android. Neither platform
 * is missing the capability — each just names it differently — so both props
 * are set unconditionally.
 */
export function PrLinkPlaceholder({ label }: Readonly<{ label: string }>) {
  return (
    <View
      testID="pr-link-placeholder"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-y-0 left-3 right-1 justify-center"
    >
      <Text
        numberOfLines={1}
        ellipsizeMode="tail"
        className="text-base font-normal text-muted-foreground leading-[normal]"
      >
        {label}
      </Text>
    </View>
  );
}
