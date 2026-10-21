import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Switch, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type BriefingPreferences, useBriefingPreferences } from '@/lib/agent-briefing';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useTRPC } from '@/lib/trpc';

export function BriefingNotificationToggle() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const router = useRouter();
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
  return (
    <View className="gap-2 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-sm">{t('agentBriefing.title')}</Text>
        <Switch
          accessibilityLabel={t('agentBriefing.title')}
          value={preferences.data?.notificationsEnabled ?? false}
          disabled={offline || !preferences.data || update.isPending}
          onValueChange={notificationsEnabled => {
            update.mutate({ notificationsEnabled });
          }}
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
          router.push('/(app)/(tabs)/(3_profile)/notifications' as Href);
        }}
      >
        <Text>{t('agentBriefing.notificationPermission')}</Text>
      </Button>
    </View>
  );
}
