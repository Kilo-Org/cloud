import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Newspaper } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { type BriefingPreferences, useBriefingPreferences } from '@/lib/agent-briefing';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

function useBriefingNotificationSwitch() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const { t } = useTranslation();
  const offline = useOfflineBannerState();
  const preferences = useBriefingPreferences();
  const update = useMutation(
    trpc.agentBriefing.updatePreferences.mutationOptions({
      onMutate: async input => {
        await client.cancelQueries({ queryKey: trpc.agentBriefing.preferences.pathKey() });
        const previous = client.getQueriesData<BriefingPreferences>({
          queryKey: trpc.agentBriefing.preferences.pathKey(),
        });
        client.setQueriesData<BriefingPreferences>(
          { queryKey: trpc.agentBriefing.preferences.pathKey() },
          data => (data ? { ...data, ...input } : data)
        );
        return { previous };
      },
      onError: (_error, _input, context) => {
        for (const [key, value] of context?.previous ?? []) {
          client.setQueryData(key, value);
        }
        toast.error(t('common.couldNotSaveSetting'));
      },
      onSettled: () => {
        void client.invalidateQueries({ queryKey: trpc.agentBriefing.preferences.pathKey() });
      },
    })
  );
  return {
    preferences,
    value: preferences.data?.notificationsEnabled ?? false,
    pending: update.isPending,
    unavailable: offline || !preferences.data || update.isPending,
    setEnabled: (notificationsEnabled: boolean) => {
      update.mutate({ notificationsEnabled });
    },
  };
}

/**
 * The notification switch for the agent brief on its own settings screen, plus
 * the way to the device's notification permission.
 */
export function BriefingNotificationToggle() {
  const router = useRouter();
  const { t } = useTranslation();
  const { preferences, value, unavailable, setEnabled } = useBriefingNotificationSwitch();
  return (
    <View className="gap-2 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-sm">{t('agentBriefing.title')}</Text>
        <Switch
          accessibilityLabel={t('agentBriefing.title')}
          value={value}
          disabled={unavailable}
          onValueChange={setEnabled}
        />
      </View>
      <Text className="text-xs text-muted-foreground">{t('agentBriefing.notificationsHint')}</Text>
      {preferences.isError ? (
        <Button
          variant="ghost"
          onPress={() => {
            void preferences.refetch();
          }}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onPress={() => {
          router.push('/(app)/notifications' as Href);
        }}
      >
        <Text>{t('agentBriefing.notificationPermission')}</Text>
      </Button>
    </View>
  );
}

/**
 * The agent brief as one row of the Notifications categories. `disabled` is the
 * screen's device-notification gate, which disables every category row.
 */
export function BriefingNotificationCategoryRow({ disabled }: Readonly<{ disabled: boolean }>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { preferences, value, pending, unavailable, setEnabled } = useBriefingNotificationSwitch();
  const isDisabled = disabled || unavailable;
  return (
    <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
      <Newspaper size={18} color={colors.secondaryForeground} />
      <View className="flex-1">
        <Text className={cn('text-sm font-medium', isDisabled && 'text-muted-foreground')}>
          {t('agentBriefing.title')}
        </Text>
        <Text variant="muted" className="mt-0.5 text-xs">
          {t('agentBriefing.notificationsHint')}
        </Text>
        {preferences.isError ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start px-0"
            onPress={() => {
              void preferences.refetch();
            }}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        ) : null}
      </View>
      {pending && <ActivityIndicator size="small" color={colors.mutedForeground} />}
      <Switch
        value={value}
        disabled={isDisabled}
        accessibilityLabel={t('agentBriefing.title')}
        accessibilityState={{ disabled: isDisabled, busy: pending }}
        onValueChange={next => {
          if (!isDisabled) {
            setEnabled(next);
          }
        }}
      />
    </View>
  );
}
