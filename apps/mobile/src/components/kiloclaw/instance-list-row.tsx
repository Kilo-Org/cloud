import { Building2, CheckCircle2, ChevronRight, UserRound } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { StatusBadge } from '@/components/kiloclaw/status-badge';
import { Text } from '@/components/ui/text';
import { type ClawInstance } from '@/lib/hooks/use-instance-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type InstanceListRowProps = {
  instance: ClawInstance;
  isCurrent: boolean;
  onPress: (sandboxId: string) => void;
};

function instanceTitle(instance: ClawInstance): string {
  return instance.name ?? 'KiloClaw instance';
}

function instanceSubtitle(instance: ClawInstance): string {
  return instance.organizationName ?? 'Personal';
}

export function InstanceListRow({ instance, isCurrent, onPress }: Readonly<InstanceListRowProps>) {
  const colors = useThemeColors();
  const Icon = instance.organizationName ? Building2 : UserRound;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${instanceTitle(instance)}`}
      onPress={() => {
        onPress(instance.sandboxId);
      }}
      className="min-h-16 flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 active:opacity-80"
    >
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
        <Icon size={18} color={colors.mutedForeground} strokeWidth={1.75} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text
            className="min-w-0 flex-1 text-base font-semibold text-foreground"
            numberOfLines={1}
          >
            {instanceTitle(instance)}
          </Text>
          {isCurrent ? <CheckCircle2 size={16} color={colors.primary} strokeWidth={2} /> : null}
        </View>
        <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <Text variant="muted" numberOfLines={1} className="max-w-[70%]">
            {instanceSubtitle(instance)}
          </Text>
          <StatusBadge status={instance.status} />
        </View>
      </View>
      <ChevronRight size={18} color={colors.mutedForeground} strokeWidth={1.75} />
    </Pressable>
  );
}
