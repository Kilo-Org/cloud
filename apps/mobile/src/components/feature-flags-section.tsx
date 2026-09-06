import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { type FeatureFlagStatus, useFeatureFlagStatuses } from '@/lib/analytics/posthog';

/**
 * Debug surface for feature flags (Preferences). Lists every registered flag
 * with what this build resolved it to and why, so a tester can see which
 * flags the build applies and which it skips because the build predates the
 * flag's minimum app version. Read-only: flags are controlled in PostHog.
 *
 * Each row reads `<value> · <source> · <version relation>`, e.g.
 * `Enabled · remote · ≥ 1.0.4`: the value the UI acts on, whether it came
 * from PostHog or the flag's default, and the gate that decided. The source
 * and relation copy is technical notation (see the i18n allowlist); the
 * translated part is the value word and the section header.
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
  if (statuses.length === 0) {
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
