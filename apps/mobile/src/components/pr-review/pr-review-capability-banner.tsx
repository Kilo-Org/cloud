// The explicit capability explanation (s6). A provider that cannot do
// something answers `{ supported: false, reason }`; this banner renders that
// answer as a visible, localized explanation — never a silent absence and
// never a generic failure. Any review surface holding a capability object
// (the merge sheet's Bitbucket auto-merge arm today, the discussion
// limitations after it) renders it through here so the wording stays one.

import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { type ProviderReviewCapability } from '@kilocode/app-shared/provider-review';

import { Text } from '@/components/ui/text';

export function PrReviewCapabilityBanner({
  capability,
}: Readonly<{ capability: ProviderReviewCapability | undefined }>) {
  const { t } = useTranslation();
  // A supported (or not-yet-loaded) capability has nothing to explain: the
  // surface renders the affordance itself, so the banner draws nothing.
  if (capability === undefined || capability.supported) {
    return null;
  }
  return (
    <View
      className="gap-1.5 rounded-lg border border-border bg-secondary p-4"
      accessibilityLabel={t('prReview.capabilities.banner.accessibility', {
        reason: capability.reason,
      })}
    >
      <Text className="text-sm font-medium text-foreground">
        {t('prReview.capabilities.banner.title')}
      </Text>
      <Text className="text-sm text-muted-foreground">{capability.reason}</Text>
    </View>
  );
}
