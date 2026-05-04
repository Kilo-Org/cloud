import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { Pressable, ScrollView, View } from 'react-native';

import { StatusBadge } from '@/components/kiloclaw/status-badge';
import { QueryError } from '@/components/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { kiloclawInstanceSwitcherTitle } from '@/lib/kiloclaw-display';
import { chatSandboxPath } from '@/lib/kilo-chat-routes';

export default function InstancePickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { currentId } = useLocalSearchParams<{ currentId: string }>();
  const instancesQuery = useAllKiloClawInstances();
  const { data: instances } = instancesQuery;

  const handleSelect = (sandboxId: string) => {
    void Haptics.selectionAsync();
    if (sandboxId === currentId) {
      router.back();
      return;
    }
    router.dismissAll();
    router.push(chatSandboxPath(sandboxId));
  };

  return (
    <ScrollView className="flex-1 bg-background">
      <View className="border-b border-border px-4 pb-3 pt-4">
        <View className="h-11 flex-row items-center justify-center">
          <Text className="text-lg font-semibold text-foreground">Switch Instance</Text>
          <Pressable
            onPress={() => {
              router.back();
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Done"
            className="absolute right-0 rounded-full bg-secondary px-4 py-2 active:opacity-70 will-change-pressable"
          >
            <Text className="text-base font-medium text-foreground">Done</Text>
          </Pressable>
        </View>
      </View>

      {instancesQuery.isPending ? (
        <View className="gap-3 px-4 py-4">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </View>
      ) : null}
      {instancesQuery.isError ? (
        <QueryError
          className="py-12"
          message="Could not load instances"
          onRetry={() => {
            void instancesQuery.refetch();
          }}
        />
      ) : null}
      {!instancesQuery.isPending && !instancesQuery.isError
        ? (instances ?? []).map(instance => {
            const isCurrent = instance.sandboxId === currentId;
            const title = kiloclawInstanceSwitcherTitle(instance);
            return (
              <Pressable
                key={instance.sandboxId}
                className="mx-4 mt-3 min-h-16 flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 active:bg-secondary will-change-pressable"
                onPress={() => {
                  handleSelect(instance.sandboxId);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${title}${isCurrent ? ', current' : ''}`}
              >
                <View className="min-w-0 flex-1 gap-1">
                  <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
                    {title}
                  </Text>
                  <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
                    <Text variant="muted" numberOfLines={1}>
                      {instance.organizationName ?? 'Personal'}
                    </Text>
                    <StatusBadge status={instance.status} />
                  </View>
                </View>
                {isCurrent ? <Check size={18} color={colors.primary} /> : null}
              </Pressable>
            );
          })
        : null}
    </ScrollView>
  );
}
