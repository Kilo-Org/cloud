import * as Haptics from 'expo-haptics';
import { Plus } from 'lucide-react-native';
import { RefreshControl, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { badgeBucketForInstance } from '@kilocode/notifications';

import { KiloClawCard, type KiloClawCardAccessIssue } from '@/components/kiloclaw/instance-card';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { type AccessRequiredSubcase } from '@/lib/analytics/onboarding-events';
import { openExternalUrl } from '@/lib/external-link';
import { type ClawInstance } from '@/lib/hooks/use-instance-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { resolveAccessIssueUrl } from '@/lib/kiloclaw/access-issue';

type Props = {
  instances: ClawInstance[];
  onSelect: (sandboxId: string) => void;
  onSettingsPress: (sandboxId: string) => void;
  onCreate: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  unreadByBadgeBucket?: Map<string, number>;
  showSectionCounts?: boolean;
  /** Personal-account billing/access issue, if any (org instances are unaffected). */
  personalAccessIssue?: AccessRequiredSubcase | null;
};

// Compact labels for the per-card banner. Kept separate from
// access-required-screen's fuller copy, which is for the dedicated
// full-screen surface, not a list row.
const ACCESS_ISSUE_LABELS: Record<AccessRequiredSubcase, string> = {
  trial_expired: 'Trial ended, subscribe to keep using this instance',
  subscription_canceled: 'Subscription inactive, resubscribe to keep using this instance',
  subscription_past_due: 'Payment issue, update billing to keep using this instance',
  quarantined: 'Instance quarantined, needs manual review',
  multiple_current_conflict: 'Account needs review',
  non_canonical_earlybird: 'Legacy plan needs review',
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
  onSelect,
  onSettingsPress,
  unreadByBadgeBucket,
  showCount,
  accessIssue,
}: Readonly<{
  title: string;
  instances: ClawInstance[];
  onSelect: (sandboxId: string) => void;
  onSettingsPress: (sandboxId: string) => void;
  unreadByBadgeBucket?: Map<string, number>;
  showCount: boolean;
  accessIssue?: KiloClawCardAccessIssue | null;
}>) {
  if (instances.length === 0) {
    return null;
  }

  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between px-4">
        <Eyebrow>{title}</Eyebrow>
        {showCount ? (
          <Text variant="mono" className="text-[10px] uppercase tracking-[1.5px] text-muted-soft">
            {instances.length}
          </Text>
        ) : null}
      </View>
      <View className="gap-3">
        {instances.map(instance => (
          <KiloClawCard
            key={instance.sandboxId}
            instance={instance}
            onPress={onSelect}
            onSettingsPress={onSettingsPress}
            unreadCount={unreadByBadgeBucket?.get(badgeBucketForInstance(instance.sandboxId)) ?? 0}
            accessIssue={accessIssue}
          />
        ))}
      </View>
    </View>
  );
}

export function InstanceListScreen({
  instances,
  onSelect,
  onSettingsPress,
  onCreate,
  refreshing,
  onRefresh,
  unreadByBadgeBucket,
  showSectionCounts = false,
  personalAccessIssue,
}: Readonly<Props>) {
  const colors = useThemeColors();
  const { personal, organizations } = splitInstances(instances);
  const personalCardAccessIssue: KiloClawCardAccessIssue | null = personalAccessIssue
    ? {
        label: ACCESS_ISSUE_LABELS[personalAccessIssue],
        onOpen: () => {
          void openExternalUrl(resolveAccessIssueUrl(personalAccessIssue), { label: 'kilo.ai' });
        },
      }
    : null;

  function handleSelect(sandboxId: string) {
    void Haptics.selectionAsync();
    onSelect(sandboxId);
  }

  function handleSettingsPress(sandboxId: string) {
    void Haptics.selectionAsync();
    onSettingsPress(sandboxId);
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="KiloClaw" size="large" showBackButton={false} className="px-[22px]" />
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <TabScreenScrollView
          className="flex-1"
          contentContainerClassName="flex-grow gap-6 pt-5"
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.mutedForeground]}
              tintColor={colors.mutedForeground}
            />
          }
        >
          {personal.length === 0 ? (
            <View className="mx-4 gap-2">
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
            onSelect={handleSelect}
            onSettingsPress={handleSettingsPress}
            unreadByBadgeBucket={unreadByBadgeBucket}
            showCount={showSectionCounts}
            accessIssue={personalCardAccessIssue}
          />
          <InstanceSection
            title="Organizations"
            instances={organizations}
            onSelect={handleSelect}
            onSettingsPress={handleSettingsPress}
            unreadByBadgeBucket={unreadByBadgeBucket}
            showCount={showSectionCounts}
          />
        </TabScreenScrollView>
      </Animated.View>
    </View>
  );
}
