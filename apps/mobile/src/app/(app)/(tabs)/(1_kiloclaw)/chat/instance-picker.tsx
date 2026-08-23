import * as Haptics from 'expo-haptics';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { Check, Server } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { StatusBadge } from '@/components/kiloclaw/status-badge';
import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type ClawInstance, useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { kiloclawInstanceSwitcherTitle } from '@/lib/kiloclaw-display';
import { chatSandboxPath } from '@/lib/kilo-chat-routes';

function InstanceRow({
  instance,
  isCurrent,
  onSelect,
}: {
  instance: ClawInstance;
  isCurrent: boolean;
  onSelect: (sandboxId: string) => void;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const title = kiloclawInstanceSwitcherTitle(instance);
  return (
    <Pressable
      className="mx-4 mt-3 min-h-16 flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 active:bg-secondary will-change-pressable"
      onPress={() => {
        onSelect(instance.sandboxId);
      }}
      accessibilityRole="button"
      accessibilityLabel={isCurrent ? t('chat.instancePicker.currentInstance', { title }) : title}
    >
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <Text variant="muted" numberOfLines={1}>
            {instance.organizationName ?? t('chat.instancePicker.personal')}
          </Text>
          <StatusBadge status={instance.status} />
        </View>
      </View>
      {isCurrent ? <Check size={18} color={colors.primary} /> : null}
    </Pressable>
  );
}

export default function InstancePickerScreen() {
  const router = useRouter();
  const { currentId } = useLocalSearchParams<{ currentId: string }>();
  const instancesQuery = useAllKiloClawInstances();
  const { data: instances } = instancesQuery;
  const { t } = useTranslation();

  const handleSelect = (sandboxId: string) => {
    void Haptics.selectionAsync();
    if (sandboxId === currentId) {
      router.back();
      return;
    }
    router.dismissAll();
    router.push(chatSandboxPath(sandboxId));
  };

  const showList = !instancesQuery.isPending && !instancesQuery.isError;
  const loadedInstances = instances ?? [];

  return (
    <PickerSheet
      title={t('chat.instancePicker.switchInstance')}
      onDone={() => {
        router.back();
      }}
    >
      {instancesQuery.isPending ? (
        <Animated.View exiting={FadeOut.duration(150)}>
          <Skeleton className="mx-4 mt-3 h-16 rounded-xl" />
          <Skeleton className="mx-4 mt-3 h-16 rounded-xl" />
          <Skeleton className="mx-4 mt-3 h-16 rounded-xl" />
        </Animated.View>
      ) : null}
      {instancesQuery.isError ? (
        <QueryError
          className="py-12"
          message={t('chat.instancePicker.couldNotLoadInstances')}
          onRetry={() => {
            void instancesQuery.refetch();
          }}
        />
      ) : null}
      {showList && loadedInstances.length === 0 ? (
        <EmptyState
          className="py-12"
          icon={Server}
          title={t('chat.instancePicker.noInstances')}
          description={t('chat.instancePicker.noInstancesDescription')}
          action={
            <Button
              variant="outline"
              onPress={() => {
                router.push('/(app)/onboarding' as Href);
              }}
            >
              <Text>{t('chat.instancePicker.setUpKiloclaw')}</Text>
            </Button>
          }
        />
      ) : null}
      {showList ? (
        <Animated.View entering={FadeIn.duration(200)}>
          {loadedInstances.map(instance => (
            <InstanceRow
              key={instance.sandboxId}
              instance={instance}
              isCurrent={instance.sandboxId === currentId}
              onSelect={handleSelect}
            />
          ))}
        </Animated.View>
      ) : null}
    </PickerSheet>
  );
}
