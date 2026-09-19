import { Platform, View } from 'react-native';

import { Text } from '@/components/ui/text';

/**
 * The visible placeholder for the PR-link field, drawn as one ellipsized line.
 *
 * Android renders a TextInput's placeholder as the native EditText hint, and
 * React Native never marks a single-line input as single-line — it only clears
 * the multiline input-type flag — so a hint wider than the field lays out on a
 * second line that the one-line field clips (pr-review-home at font scale 2).
 * `numberOfLines` cannot stop it: the hint layout ignores it. Drawing the
 * placeholder ourselves keeps it on one line at any font scale or translation
 * length, and the field keeps its native hint (transparent) for the
 * accessibility and digest text.
 *
 * iOS truncates its own placeholder, so this renders nothing there.
 */
export function PrLinkPlaceholder({ label }: Readonly<{ label: string }>) {
  if (Platform.OS !== 'android') {
    return null;
  }
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
