import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Newspaper } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { type BriefingPreferences, useBriefingPreferences } from '@/lib/agent-briefing';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

function useBriefingNotificationSwitch() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const { t, i18n } = useTranslation();
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
    // An offline-paused first fetch stays pending forever: the placeholder is a
    // wait this row cannot own, so connectivity gates it like the screens do.
    loading: preferences.isPending && !offline,
    pending: update.isPending,
    unavailable: offline || !preferences.data || update.isPending,
    setEnabled: (notificationsEnabled: boolean) => {
      const current = preferences.data;
      if (!current || offline || update.isPending) {
        return;
      }
      update.mutate({
        notificationsEnabled,
        timezone: current.timezone,
        nightStart: current.nightStart,
        morningStart: current.morningStart,
        morningEnd: current.morningEnd,
        language: i18n.resolvedLanguage ?? i18n.language,
      });
    },
  };
}

/**
 * The notification switch for the agent brief on its own settings screen, plus
 * the way to the device's notification permission.
 *
 * While the preferences read is pending the value is unknown, so the switch's
 * 44dp slot holds a `Skeleton` and the row does not shift when the value
 * arrives.
 */
export function BriefingNotificationToggle() {
  const router = useRouter();
  const { t } = useTranslation();
  const { preferences, value, unavailable, loading, setEnabled } = useBriefingNotificationSwitch();
  return (
    <View className="gap-2 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-sm">{t('agentBriefing.title')}</Text>
        {loading ? (
          <Skeleton className="h-11 w-11 rounded-full" />
        ) : (
          <Switch
            accessibilityLabel={t('agentBriefing.title')}
            value={value}
            disabled={unavailable}
            onValueChange={setEnabled}
          />
        )}
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
 *
 * While the preferences read is pending the row is busy and disabled, and its
 * switch slot holds a `Skeleton`, so assistive tech does not read a control it
 * cannot use and the row does not shift when the value arrives.
 */
export function BriefingNotificationCategoryRow({ disabled }: Readonly<{ disabled: boolean }>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { preferences, value, pending, loading, unavailable, setEnabled } =
    useBriefingNotificationSwitch();
  const isDisabled = disabled || unavailable || loading;
  return (
    <View
      className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3"
      accessibilityState={{ busy: pending || loading, disabled: isDisabled }}
    >
      <IconTile icon={Newspaper} tint={NEUTRAL_TINT} />
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
            className={cn(STATE_ACTION_CLASS, 'self-start px-0')}
            onPress={() => {
              void preferences.refetch();
            }}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        ) : null}
      </View>
      {pending && <ActivityIndicator size="small" color={colors.mutedForeground} />}
      {loading ? (
        <Skeleton className="h-11 w-11 rounded-full" />
      ) : (
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
      )}
    </View>
  );
}
