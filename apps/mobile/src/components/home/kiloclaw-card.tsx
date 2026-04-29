import { useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import { isTransitionalStatus, statusLabel, statusTone } from '@/components/kiloclaw/status-badge';
import { StatusDot } from '@/components/ui/status-dot';
import { Text } from '@/components/ui/text';
import { agentColor } from '@/lib/agent-color';
import { useKiloClawLatestMessage } from '@/lib/hooks/use-kiloclaw-latest-message';
import { useKiloClawStatus, useKiloClawStatusQueryKey } from '@/lib/hooks/use-kiloclaw-queries';
import { parseTimestamp } from '@/lib/utils';

type KiloClawCardProps = {
  instance: {
    sandboxId: string;
    name: string | null;
    organizationId: string | null;
    organizationName: string | null;
    status: string | null;
  };
  unreadCount?: number;
};

type CachedStatus = NonNullable<ReturnType<typeof useKiloClawStatus>['data']>;

function formatUnreadCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

function formatMessagePreview(
  message: { text: string; isFromMe: boolean },
  botEmoji: string | null
): string {
  const text = message.text.length > 0 ? message.text : 'New message';
  if (message.isFromMe) {
    return `You: ${text}`;
  }
  return botEmoji ? `${botEmoji} ${text}` : text;
}

function formatClockTime(date: Date): string {
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(displayHours)}:${minutes} ${period}`;
}

function firstLetter(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? (trimmed[0]?.toUpperCase() ?? 'K') : 'K';
}

export function KiloClawCard({ instance, unreadCount = 0 }: Readonly<KiloClawCardProps>) {
  const router = useRouter();

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
  const { data: latest } = useKiloClawLatestMessage(instance.organizationId);

  const botEmoji = status?.botEmoji ?? null;
  const displayName = status?.botName ?? instance.name ?? 'KiloClaw';
  const rawStatus = status?.status ?? instance.status ?? 'offline';
  const tone = statusTone(rawStatus);
  const label = statusLabel(rawStatus);
  const tapDisabled = isTransitionalStatus(rawStatus);

  const hue = agentColor(displayName);
  const lastMessageTime = latest ? formatClockTime(parseTimestamp(latest.created_at)) : null;

  const hasUnread = unreadCount > 0;
  const accessibilityLabel = hasUnread
    ? `Open ${displayName}, ${unreadCount} unread ${unreadCount === 1 ? 'message' : 'messages'}`
    : `Open ${displayName}`;

  const handlePress = () => {
    router.push(`/(app)/chat/${instance.sandboxId}` as Href);
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={tapDisabled}
      className="relative mx-4 overflow-hidden rounded-2xl border border-border bg-card p-4 pl-5 active:opacity-80"
      accessibilityLabel={accessibilityLabel}
    >
      <View className={`absolute bottom-0 left-0 top-0 w-[3px] ${hue.hueClass}`} />
      <View className="flex-row items-center gap-3">
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
        <View className="flex-1">
          <View className="flex-row items-center justify-between gap-2">
            <Text
              className="shrink text-[17px] font-semibold tracking-tight text-foreground"
              numberOfLines={1}
            >
              {displayName}
            </Text>
            {lastMessageTime ? (
              <Text variant="eyebrow" className="shrink-0">
                {lastMessageTime}
              </Text>
            ) : null}
          </View>
          <View className="mt-1 flex-row items-center gap-1.5">
            <StatusDot tone={tone} glow />
            <Text className="text-[12px] font-medium text-muted-foreground">{label}</Text>
          </View>
        </View>
        {hasUnread ? (
          <View className="min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5">
            <Text className="text-xs font-semibold leading-none text-white">
              {formatUnreadCount(unreadCount)}
            </Text>
          </View>
        ) : null}
      </View>

      {latest ? (
        <View className="mt-3 rounded-lg bg-muted p-3">
          <Text className="text-[13px] text-ink2" numberOfLines={2}>
            {formatMessagePreview(latest, botEmoji)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
