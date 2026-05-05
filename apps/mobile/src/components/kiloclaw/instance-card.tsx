import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Settings2 } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { isTransitionalStatus, statusLabel, statusTone } from '@/components/kiloclaw/status-badge';
import { StatusDot } from '@/components/ui/status-dot';
import { Text } from '@/components/ui/text';
import { agentColor } from '@/lib/agent-color';
import { useKiloClawStatus, useKiloClawStatusQueryKey } from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { chatSandboxPath } from '@/lib/kilo-chat-routes';

type KiloClawCardProps = {
  instance: {
    sandboxId: string;
    name: string | null;
    botName?: string | null;
    botEmoji?: string | null;
    organizationId: string | null;
    organizationName: string | null;
    status: string | null;
  };
  unreadCount?: number;
  onPress?: (sandboxId: string) => void;
  onSettingsPress?: (sandboxId: string) => void;
};

type CachedStatus = NonNullable<ReturnType<typeof useKiloClawStatus>['data']>;

function formatUnreadCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

function firstLetter(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? (trimmed[0]?.toUpperCase() ?? 'K') : 'K';
}

export function KiloClawCard({
  instance,
  unreadCount = 0,
  onPress,
  onSettingsPress,
}: Readonly<KiloClawCardProps>) {
  const router = useRouter();
  const colors = useThemeColors();

  // Peek at the latest cached status (non-subscribing) so we can choose the
  // poll cadence before subscribing. Falls back to the list's status when
  // the status cache is cold. When the live query refreshes below,
  // re-render recomputes this and the interval flips.
  const queryClient = useQueryClient();
  const statusQueryKey = useKiloClawStatusQueryKey(instance.organizationId);
  const cachedStatus = queryClient.getQueryData<CachedStatus>(statusQueryKey);
  const effectiveStatus = cachedStatus?.status ?? instance.status ?? null;
  const fastPoll = isTransitionalStatus(effectiveStatus);

  const { data: status } = useKiloClawStatus(
    instance.organizationId,
    true,
    fastPoll ? 5000 : 10_000
  );

  const botEmoji = status?.botEmoji ?? instance.botEmoji ?? null;
  const displayName = status?.botName ?? instance.botName ?? instance.name ?? 'KiloClaw';
  const rawStatus = status?.status ?? instance.status ?? 'offline';
  const tone = statusTone(rawStatus);
  const label = statusLabel(rawStatus);
  const tapDisabled = isTransitionalStatus(rawStatus);

  const hue = agentColor(displayName);

  const hasUnread = unreadCount > 0;
  const accessibilityLabel = hasUnread
    ? `Open ${displayName}, ${unreadCount} unread ${unreadCount === 1 ? 'message' : 'messages'}`
    : `Open ${displayName}`;

  const handlePress = () => {
    if (onPress) {
      onPress(instance.sandboxId);
      return;
    }
    router.push(chatSandboxPath(instance.sandboxId));
  };

  const handleSettingsPress = () => {
    onSettingsPress?.(instance.sandboxId);
  };

  return (
    <View className="relative mx-4 overflow-hidden rounded-2xl border border-border bg-card p-4 pl-5">
      <View className={`absolute bottom-0 left-0 top-0 w-[3px] ${hue.hueClass}`} />
      <View className="flex-row items-center gap-3">
        <Pressable
          onPress={handlePress}
          disabled={tapDisabled}
          className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-80"
          accessibilityLabel={accessibilityLabel}
        >
          <View
            className={`h-[38px] w-[38px] items-center justify-center rounded-[10px] border ${hue.tileBgClass} ${hue.tileBorderClass}`}
          >
            {botEmoji ? (
              <Text className="text-lg">{botEmoji}</Text>
            ) : (
              <Text className={`text-[15px] font-bold ${hue.hueTextClass}`}>
                {firstLetter(displayName)}
              </Text>
            )}
          </View>
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center justify-between gap-2">
              <Text
                className="shrink text-[17px] font-semibold tracking-tight text-foreground"
                numberOfLines={1}
              >
                {displayName}
              </Text>
            </View>
            <View className="mt-1 flex-row items-center gap-1.5">
              <StatusDot tone={tone} glow />
              <Text className="text-[12px] font-medium text-muted-foreground">{label}</Text>
            </View>
          </View>
        </Pressable>
        {hasUnread ? (
          <View className="min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5">
            <Text className="text-xs font-semibold leading-none text-white">
              {formatUnreadCount(unreadCount)}
            </Text>
          </View>
        ) : null}
        {onSettingsPress ? (
          <Pressable
            onPress={handleSettingsPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Open settings for ${displayName}`}
            className="h-9 w-9 items-center justify-center rounded-full active:opacity-70"
          >
            <Settings2 size={18} color={colors.mutedForeground} strokeWidth={1.75} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
