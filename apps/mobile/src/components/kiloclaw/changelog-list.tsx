import { Bug, RefreshCw, Sparkles } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { captureEvent, INSTANCE_ACTION_EVENT } from '@/lib/analytics/posthog';
import { formatCalendarDate } from '@/lib/format';
import { type useKiloClawChangelog } from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type ChangelogEntry = NonNullable<ReturnType<typeof useKiloClawChangelog>['data']>[number];

const DEPLOY_HINTS = {
  redeploy_suggested: {
    labelKey: 'kiloclaw.changelog.redeploySuggested',
    bgClass: 'bg-info-tile-bg',
    textClass: 'text-info',
  },
  redeploy_required: {
    labelKey: 'kiloclaw.changelog.redeployRequired',
    bgClass: 'bg-warn-tile-bg',
    textClass: 'text-warn',
  },
  upgrade_required: {
    labelKey: 'kiloclaw.changelog.upgradeRequired',
    bgClass: 'bg-danger-tile-bg',
    textClass: 'text-destructive',
  },
} as const satisfies Record<string, { labelKey: string; bgClass: string; textClass: string }>;

export function ChangelogList({
  entries,
  isRedeploying,
  onRedeploy,
  onUpgrade,
}: Readonly<{
  entries: ChangelogEntry[];
  isRedeploying: boolean;
  onRedeploy: () => void;
  onUpgrade: () => void;
}>) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  return (
    <View className="gap-3">
      {entries.map((entry, index) => {
        const isBugfix = entry.category === 'bugfix';
        const Icon = isBugfix ? Bug : Sparkles;
        const iconColor = isBugfix ? '#f97316' : '#8b5cf6';
        const deployHint = entry.deployHint ? DEPLOY_HINTS[entry.deployHint] : undefined;

        return (
          <View key={`${entry.date}-${index}`} className="rounded-lg bg-secondary p-3 gap-2">
            <View className="flex-row items-center gap-2">
              <Icon size={14} color={iconColor} />
              <Text variant="muted" className="text-xs">
                {formatCalendarDate(entry.date, i18n.language)}
              </Text>
              {deployHint && (
                <View className={cn('rounded px-1.5 py-0.5', deployHint.bgClass)}>
                  <Text className={cn('text-xs', deployHint.textClass)}>
                    {t(deployHint.labelKey)}
                  </Text>
                </View>
              )}
            </View>
            <Text className="text-sm leading-relaxed">{entry.description}</Text>
            {entry.deployHint === 'redeploy_required' && (
              <Button
                size="sm"
                variant="outline"
                loading={isRedeploying}
                onPress={() => {
                  captureEvent(INSTANCE_ACTION_EVENT, { surface: 'claw', action: 'redeploy' });
                  onRedeploy();
                }}
                className="flex-row gap-1.5 self-start"
              >
                {!isRedeploying && <RefreshCw size={14} color={colors.foreground} />}
                <Text>{t('kiloclaw.redeploy')}</Text>
              </Button>
            )}
            {entry.deployHint === 'upgrade_required' && (
              <Button size="sm" variant="outline" onPress={onUpgrade} className="self-start">
                <Text>{t('kiloclaw.changelog.manageVersion')}</Text>
              </Button>
            )}
          </View>
        );
      })}
    </View>
  );
}
