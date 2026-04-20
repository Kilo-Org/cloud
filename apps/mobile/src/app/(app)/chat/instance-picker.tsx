import * as Haptics from 'expo-haptics';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { Pressable, ScrollView, View } from 'react-native';

import { StatusBadge } from '@/components/kiloclaw/status-badge';
import { Text } from '@/components/ui/text';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { type InstanceStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export default function InstancePickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { currentId } = useLocalSearchParams<{ currentId: string }>();
  const { data: instances } = useAllKiloClawInstances();

  const handleSelect = (sandboxId: string) => {
    void Haptics.selectionAsync();
    if (sandboxId === currentId) {
      router.back();
      return;
    }
    router.dismissAll();
    router.push(`/(app)/chat/${sandboxId}` as Href);
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

      {(instances ?? []).map(instance => {
        const isCurrent = instance.sandboxId === currentId;
        return (
          <Pressable
            key={instance.sandboxId}
            className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary will-change-pressable"
            onPress={() => {
              handleSelect(instance.sandboxId);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${instance.name ?? instance.sandboxId}${isCurrent ? ', current' : ''}`}
          >
            <View className="flex-1 gap-1">
              <Text className="text-base text-foreground" numberOfLines={1}>
                {instance.name ?? instance.sandboxId}
              </Text>
              <StatusBadge status={instance.status as InstanceStatus} />
            </View>
            {isCurrent && <Check size={18} color={colors.primary} />}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
