// The explicit capability explanation (s6). A provider that cannot do
// something answers `{ supported: false, reason }`; this banner renders that
// answer as a visible, localized explanation — never a silent absence and
// never a generic failure. Any review surface holding a capability object
// (the merge sheet's Bitbucket auto-merge arm today, the discussion
// limitations after it) renders it through here so the wording stays one.
// The provider's raw reason string is only the fallback: a surface that
// recognizes the capability (auto-merge on Bitbucket) passes catalog copy
// through `title`/`reason`, so the explanation is translated, not quoted.
// The banner is conditional content below a section, so it fades in/out on
// mount transitions instead of jumping the layout (AGENTS.md).

import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { type ProviderReviewCapability } from '@kilocode/app-shared/provider-review';

import { Text } from '@/components/ui/text';

export function PrReviewCapabilityBanner({
  capability,
  title,
  reason,
}: Readonly<{
  capability: ProviderReviewCapability | undefined;
  /** Localized title override for a capability the catalog names. */
  title?: string;
  /** Localized reason override; `capability.reason` stays the fallback. */
  reason?: string;
}>) {
  const { t } = useTranslation();
  // A supported (or not-yet-loaded) capability has nothing to explain: the
  // surface renders the affordance itself, so the banner draws nothing.
  if (capability === undefined || capability.supported) {
    return null;
  }
  const bannerReason = reason ?? capability.reason;
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      className="gap-1.5 rounded-lg border border-border bg-secondary p-4"
      accessibilityLabel={t('prReview.capabilities.banner.accessibility', {
        reason: bannerReason,
      })}
    >
      <Text className="text-sm font-medium text-foreground">
        {title ?? t('prReview.capabilities.banner.title')}
      </Text>
      <Text className="text-sm text-muted-foreground">{bannerReason}</Text>
    </Animated.View>
  );
}
