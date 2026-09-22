import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { type FeatureFlagStatus, useFeatureFlagStatuses } from '@/lib/analytics/posthog';

/**
 * Development-only debug surface for feature flags (Preferences). Lists every
 * registered flag with what this build resolved it to and why, so a tester
 * can see which flags the build applies and which it skips because the build
 * predates the flag's minimum app version. Read-only: flags are controlled in
 * PostHog. Renders nothing when `__DEV__` is false.
 *
 * Each row reads `<value> · <source> · <version relation>`, e.g.
 * `Enabled · remote · ≥ 1.0.4`: the value the UI acts on, whether it came
 * from PostHog or the flag's default, and the gate that decided. Both the
 * value word and the reason copy come from the catalog, so the row reads in
 * the reader's language; only the flag key and the build version are notation.
 */
function FlagRow({ status }: { status: FeatureFlagStatus }) {
  const { t } = useTranslation();
  const value = status.value ? t('common.enabled') : t('common.off');
  let reason = t('preferences.featureFlagNotLoaded');
  // A below-minimum build is decided by the app version alone: the gate copy
  // must show even before (or without) a remote value arriving for the key.
  if (status.loaded || status.reason === 'build-too-old') {
    reason = status.applied
      ? t('preferences.featureFlagApplied', { min: status.minAppVersion })
      : t('preferences.featureFlagSkipped', { min: status.minAppVersion });
  }
  return (
    <View className="rounded-lg bg-secondary px-3 py-3">
      <Text className="text-sm font-medium">{status.key}</Text>
      <Text variant="muted" className="mt-0.5 text-xs">
        {value} · {reason}
      </Text>
    </View>
  );
}

export function FeatureFlagsSection() {
  const { t } = useTranslation();
  const statuses = useFeatureFlagStatuses();
  if (!__DEV__ || statuses.length === 0) {
    return null;
  }
  return (
    <View className="mt-3 gap-3">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('preferences.featureFlags')}
      </Text>
      <View className="gap-3">
        {statuses.map(status => (
          <FlagRow key={status.key} status={status} />
        ))}
      </View>
      <Text variant="muted" className="text-xs">
        {t('preferences.featureFlagsBuild', {
          version: statuses[0]?.appVersion ?? '?',
        })}
      </Text>
    </View>
  );
}
