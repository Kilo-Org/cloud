import { type Href, useRouter } from 'expo-router';
import { Bot, ChevronRight } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useKiloClawLatestMessage } from '@/lib/hooks/use-kiloclaw-latest-message';
import { useKiloClawStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type KiloClawCardProps = {
  instance: {
    sandboxId: string;
    name: string | null;
    organizationId: string | null;
    organizationName: string | null;
    status: string | null;
  };
};

function formatMessagePreview(message: { text: string; senderName: string }): string {
  const text = message.text.length > 0 ? message.text : 'New message';
  return message.senderName.length > 0 ? `${message.senderName}: ${text}` : text;
}

export function KiloClawCard({ instance }: Readonly<KiloClawCardProps>) {
  const router = useRouter();
  const colors = useThemeColors();

  const { data: status } = useKiloClawStatus(instance.organizationId);
  const { data: latest } = useKiloClawLatestMessage(instance.organizationId);

  const botEmoji = status?.botEmoji ?? null;
  const displayName = status?.botName ?? instance.name ?? 'KiloClaw';
  const isRunning = (status?.status ?? instance.status) === 'running';

  const statusLabel = isRunning ? 'Online' : 'Offline';
  const subtitleLabel = instance.organizationName
    ? `${statusLabel} · ${instance.organizationName}`
    : statusLabel;

  const handlePress = () => {
    router.push(`/(app)/chat/${instance.sandboxId}` as Href);
  };

  return (
    <Pressable
      onPress={handlePress}
      className="mx-4 rounded-xl border border-border bg-card p-4 active:opacity-80"
      accessibilityLabel={`Open ${displayName}`}
    >
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          {botEmoji ? (
            <Text className="text-xl">{botEmoji}</Text>
          ) : (
            <Bot size={20} color={colors.foreground} />
          )}
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="text-base font-semibold" numberOfLines={1}>
            {displayName}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <View
              className={
                isRunning
                  ? 'h-1.5 w-1.5 rounded-full bg-green-500'
                  : 'h-1.5 w-1.5 rounded-full bg-neutral-400 dark:bg-neutral-600'
              }
            />
            <Text variant="muted" className="text-xs" numberOfLines={1}>
              {subtitleLabel}
            </Text>
          </View>
        </View>
        <ChevronRight size={18} color={colors.mutedForeground} />
      </View>

      {latest ? (
        <View className="mt-3 border-t border-border pt-3">
          <Text variant="muted" className="text-sm" numberOfLines={2}>
            {formatMessagePreview(latest)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
