import { type Href, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Plus, Server } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { SectionList, type SectionListData, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { InstanceRow } from '@/components/kiloclaw/instance-row';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { type InstanceStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ClawInstance = NonNullable<ReturnType<typeof useAllKiloClawInstances>['data']>[number];

type Section = SectionListData<ClawInstance, { title: string }>;

function groupByContext(instances: ClawInstance[]): Section[] {
  const personal: ClawInstance[] = [];
  const orgMap = new Map<string, { name: string; items: ClawInstance[] }>();

  for (const inst of instances) {
    if (!inst.organizationId) {
      personal.push(inst);
    } else {
      const key = inst.organizationId;
      const existing = orgMap.get(key);
      if (existing) {
        existing.items.push(inst);
      } else {
        orgMap.set(key, { name: inst.organizationName ?? 'Organization', items: [inst] });
      }
    }
  }

  const sections: Section[] = [];
  if (personal.length > 0) {
    sections.push({ title: 'Personal', data: personal });
  }
  for (const { name, items } of orgMap.values()) {
    sections.push({ title: name, data: items });
  }
  return sections;
}

export default function KiloClawInstanceList() {
  const router = useRouter();
  const colors = useThemeColors();
  const { data: instances, isPending, isError, refetch } = useAllKiloClawInstances();
  const didAutoRedirect = useRef(false);

  useEffect(() => {
    if (didAutoRedirect.current || !instances) {
      return;
    }
    didAutoRedirect.current = true;
    if (instances.length === 1) {
      const instance = instances[0];
      if (instance) {
        router.push(`/(app)/chat/${instance.sandboxId}` as Href);
      }
    }
  }, [instances, router]);

  const sections = instances ? groupByContext(instances) : [];

  const handlePress = (inst: ClawInstance) => {
    router.push(`/(app)/chat/${inst.sandboxId}` as Href);
  };

  const handleSettingsPress = (inst: ClawInstance) => {
    router.push(`/(app)/(tabs)/(1_kiloclaw)/${inst.sandboxId}/dashboard` as Href);
  };

  if (isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="KiloClaw" headerRight={<ProfileAvatarButton />} />
        <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4">
          <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </Animated.View>
        </Animated.View>
      </View>
    );
  }

  if (isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="KiloClaw" headerRight={<ProfileAvatarButton />} />
        <View className="flex-1 items-center justify-center px-4">
          <QueryError
            message="Could not load your instances"
            onRetry={() => {
              void refetch();
            }}
          />
        </View>
      </View>
    );
  }

  if (instances.length === 0) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="KiloClaw" headerRight={<ProfileAvatarButton />} />
        <Animated.View
          entering={FadeIn.duration(200)}
          className="flex-1 items-center justify-center px-4"
        >
          <EmptyState
            icon={Server}
            title="No KiloClaw instances"
            description="You don't have any KiloClaw instances yet."
            action={
              <Button
                variant="outline"
                onPress={() => {
                  void WebBrowser.openBrowserAsync('https://app.kilo.ai/claw');
                }}
              >
                <Plus size={16} color={colors.foreground} />
                <Text>Create</Text>
              </Button>
            }
          />
        </Animated.View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="KiloClaw" headerRight={<ProfileAvatarButton />} />
      <Animated.View layout={LinearTransition} className="flex-1">
        <SectionList
          sections={sections}
          keyExtractor={item => item.sandboxId}
          contentContainerClassName="px-4 pt-4 pb-8 gap-2"
          renderSectionHeader={({ section }) =>
            sections.length > 1 ? (
              <View className="pb-1 pt-3">
                <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
                  {section.title}
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <Animated.View entering={FadeIn.duration(200)}>
              <InstanceRow
                name={item.name}
                sandboxId={item.sandboxId}
                status={item.status as InstanceStatus}
                disabled={item.status === 'destroying'}
                onPress={() => {
                  handlePress(item);
                }}
                onSettingsPress={() => {
                  handleSettingsPress(item);
                }}
              />
            </Animated.View>
          )}
          stickySectionHeadersEnabled={false}
        />
      </Animated.View>
    </View>
  );
}
