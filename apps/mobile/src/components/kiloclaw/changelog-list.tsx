import { Bug, Sparkles } from 'lucide-react-native';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type useKiloClawChangelog } from '@/lib/hooks/use-kiloclaw-queries';
import { cn } from '@/lib/utils';

type ChangelogEntry = NonNullable<ReturnType<typeof useKiloClawChangelog>['data']>[number];

const DEPLOY_HINTS: Record<string, { label: string; bgClass: string; textClass: string }> = {
  redeploy_suggested: {
    label: 'Redeploy suggested',
    bgClass: 'bg-blue-100 dark:bg-blue-950',
    textClass: 'text-blue-700 dark:text-blue-300',
  },
  redeploy_required: {
    label: 'Redeploy required',
    bgClass: 'bg-amber-100 dark:bg-amber-950',
    textClass: 'text-amber-700 dark:text-amber-300',
  },
  upgrade_required: {
    label: 'Upgrade required',
    bgClass: 'bg-red-100 dark:bg-red-950',
    textClass: 'text-red-700 dark:text-red-300',
  },
};

export function ChangelogList({ entries }: Readonly<{ entries: ChangelogEntry[] }>) {
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
                {entry.date}
              </Text>
              {deployHint && (
                <View className={cn('rounded px-1.5 py-0.5', deployHint.bgClass)}>
                  <Text className={cn('text-xs', deployHint.textClass)}>{deployHint.label}</Text>
                </View>
              )}
            </View>
            <Text className="text-sm leading-relaxed">{entry.description}</Text>
          </View>
        );
      })}
    </View>
  );
}
