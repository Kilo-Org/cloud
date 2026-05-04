import * as Haptics from 'expo-haptics';
import { Plus } from 'lucide-react-native';
import { RefreshControl, ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { InstanceListRow } from '@/components/kiloclaw/instance-list-row';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { type ClawInstance } from '@/lib/hooks/use-instance-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type Props = {
  instances: ClawInstance[];
  currentSandboxId: string | null;
  onSelect: (sandboxId: string) => void;
  onCreate: () => void;
  refreshing: boolean;
  onRefresh: () => void;
};

function splitInstances(instances: ClawInstance[]) {
  return {
    personal: instances.filter(instance => instance.organizationId === null),
    organizations: instances.filter(instance => instance.organizationId !== null),
  };
}

function InstanceSection({
  title,
  instances,
  currentSandboxId,
  onSelect,
}: Readonly<{
  title: string;
  instances: ClawInstance[];
  currentSandboxId: string | null;
  onSelect: (sandboxId: string) => void;
}>) {
  if (instances.length === 0) {
    return null;
  }

  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between px-1">
        <Eyebrow>{title}</Eyebrow>
        <Text variant="mono" className="text-[10px] uppercase tracking-[1.5px] text-muted-soft">
          {instances.length}
        </Text>
      </View>
      <View className="gap-3">
        {instances.map(instance => (
          <InstanceListRow
            key={instance.sandboxId}
            instance={instance}
            isCurrent={instance.sandboxId === currentSandboxId}
            onPress={onSelect}
          />
        ))}
      </View>
    </View>
  );
}

export function InstanceListScreen({
  instances,
  currentSandboxId,
  onSelect,
  onCreate,
  refreshing,
  onRefresh,
}: Readonly<Props>) {
  const colors = useThemeColors();
  const { personal, organizations } = splitInstances(instances);

  function handleSelect(sandboxId: string) {
    void Haptics.selectionAsync();
    onSelect(sandboxId);
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="KiloClaw"
        size="large"
        showBackButton={false}
        className="px-[22px]"
        headerRight={<ProfileAvatarButton />}
      />
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-6 px-4 pb-24"
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {instances.length === 0 ? (
            <View className="gap-2">
              <Button
                className="mt-1 h-11"
                onPress={() => {
                  void Haptics.selectionAsync();
                  onCreate();
                }}
                accessibilityLabel="Create instance"
              >
                <Plus size={16} color={colors.primaryForeground} />
                <Text>Create instance</Text>
              </Button>
            </View>
          ) : null}

          <InstanceSection
            title="Personal"
            instances={personal}
            currentSandboxId={currentSandboxId}
            onSelect={handleSelect}
          />
          <InstanceSection
            title="Organizations"
            instances={organizations}
            currentSandboxId={currentSandboxId}
            onSelect={handleSelect}
          />
        </ScrollView>
      </Animated.View>
    </View>
  );
}
