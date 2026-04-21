import { type Href, useRouter } from 'expo-router';
import { Settings } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

function BotStatusIndicator({ online }: { online: boolean }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <View className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-neutral-500'}`} />
      <Text className="text-xs text-muted-foreground">{online ? 'Online' : 'Offline'}</Text>
    </View>
  );
}

export function ChatHeader({
  instanceId,
  title,
  botOnline,
}: {
  instanceId: string;
  title: string;
  botOnline?: boolean;
}) {
  const router = useRouter();
  const colors = useThemeColors();
  const { data: instances } = useAllKiloClawInstances();

  const hasMultipleInstances = (instances?.length ?? 0) > 1;

  const handleTitlePress = () => {
    const href: Href = {
      pathname: '/(app)/chat/instance-picker',
      params: { currentId: instanceId },
    };
    router.push(href);
  };

  const settingsButton = (
    <Pressable
      onPress={() => {
        router.push(`/(app)/kiloclaw/${instanceId}/dashboard` as Href);
      }}
      hitSlop={12}
      accessibilityLabel="Settings"
      className="active:opacity-70"
    >
      <Settings size={20} color={colors.foreground} />
    </Pressable>
  );

  return (
    <ScreenHeader
      title={title}
      onTitlePress={hasMultipleInstances ? handleTitlePress : undefined}
      headerRight={
        <View className="flex-row items-center gap-3">
          {botOnline !== undefined && <BotStatusIndicator online={botOnline} />}
          {settingsButton}
        </View>
      }
    />
  );
}

export function ChatShell({
  instanceId,
  name,
  children,
}: {
  instanceId: string;
  name: string;
  children: React.ReactNode;
}) {
  return (
    <View className="flex-1 bg-background">
      <ChatHeader instanceId={instanceId} title={name} />
      {children}
    </View>
  );
}
