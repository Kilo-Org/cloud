import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Bell, Newspaper } from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { type BriefingPreferences, useBriefingPreferences } from '@/lib/agent-briefing';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useTRPC } from '@/lib/trpc';

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
 * While the preferences read is pending the value is unknown, so the switch
 * row is the shared row skeleton with its switch slot: the row the value lands
 * in keeps the height already on screen, and assistive tech never meets a
 * switch nothing has read yet.
 */
export function BriefingNotificationToggle() {
  const router = useRouter();
  const { t } = useTranslation();
  const { preferences, value, unavailable, loading, setEnabled } = useBriefingNotificationSwitch();
  return (
    <>
      <RowGroup>
        {loading ? (
          <RowSkeleton subtitle trailing="switch" />
        ) : (
          <PreferenceRow
            title={t('agentBriefing.title')}
            subtitle={t('agentBriefing.notificationsHint')}
            value={value}
            disabled={unavailable}
            onValueChange={setEnabled}
          />
        )}
        {/* The permission sentence is a notice, so it is the row's subtitle
            under a title that names where it leads. As the last button's label
            it was prose drawn bold and centered, which read as a heading. */}
        <ConfigureRow
          icon={Bell}
          title={t('common.notifications')}
          subtitle={t('agentBriefing.notificationPermission')}
          onPress={() => {
            router.push('/(app)/notifications' as Href);
          }}
        />
      </RowGroup>
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
    </>
  );
}

/**
 * The agent brief as one row of the Notifications categories. `disabled` is the
 * screen's device-notification gate, which disables every category row.
 *
 * While the preferences read is pending the row is the shared row skeleton, so
 * the row that will carry the value is the one already on screen, at the same
 * height, and assistive tech never meets a switch nothing has read yet.
 */
export function BriefingNotificationCategoryRow({ disabled }: Readonly<{ disabled: boolean }>) {
  const { t } = useTranslation();
  const { preferences, value, pending, loading, unavailable, setEnabled } =
    useBriefingNotificationSwitch();
  // The screens that stack this row retry their own query, which is not this
  // one: a failed brief read must offer its own retry at the row, or the
  // category is left disabled with no way back short of a screen reload.
  if (preferences.isError) {
    return (
      <ConfigureRow
        icon={Newspaper}
        title={t('agentBriefing.title')}
        subtitle={t('agentBriefing.notificationsHint')}
        variant="action"
        onPress={() => {
          void preferences.refetch();
        }}
        accessibilityLabel={[t('agentBriefing.title'), t('common.retry')].join('. ')}
        trailing={
          <Text variant="caption" className="text-destructive">
            {t('common.retry')}
          </Text>
        }
      />
    );
  }
  if (loading) {
    return <RowSkeleton tile subtitle trailing="switch" />;
  }
  return (
    <PreferenceRow
      icon={Newspaper}
      title={t('agentBriefing.title')}
      subtitle={t('agentBriefing.notificationsHint')}
      value={value}
      disabled={disabled || unavailable}
      busy={pending}
      onValueChange={setEnabled}
    />
  );
}
