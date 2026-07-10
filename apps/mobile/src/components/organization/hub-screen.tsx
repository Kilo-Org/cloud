import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { Bell, FileText, Pencil, Receipt, Users } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { OrgUsageStats } from '@/components/organization/org-usage-stats';
import { RenameOrgModal } from '@/components/organization/rename-org-modal';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { KvRow } from '@/components/ui/kv-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import { isMoneyRole, useOrgRole, useOrgWithMembers } from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

function InfoCardSkeleton() {
  return (
    <View className="gap-2.5 rounded-lg bg-secondary px-3 py-3">
      <Skeleton className="h-5 w-2/3 rounded-md" />
      <Skeleton className="h-5 w-1/3 rounded-md" />
    </View>
  );
}

export function OrganizationHubScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { organizationId, role, org, isLoading } = useOrgRole();
  const orgWithMembers = useOrgWithMembers(organizationId);
  const mutations = useOrganizationMutations(organizationId ?? '');
  const [renameVisible, setRenameVisible] = useState(false);

  if (organizationId == null) {
    return null;
  }

  const showMoney = isMoneyRole(role);
  const minimumBalance = orgWithMembers.data?.settings.minimum_balance;
  const lowBalanceSubtitle = minimumBalance != null ? `Below $${minimumBalance.toFixed(2)}` : 'Off';

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={org?.organizationName ?? 'Organization'} />
      <ScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-6 pt-4 pb-8"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View layout={LinearTransition}>
          {isLoading || !org ? (
            <Animated.View exiting={FadeOut.duration(150)}>
              <InfoCardSkeleton />
            </Animated.View>
          ) : (
            <Animated.View entering={FadeIn.duration(200)} className="rounded-lg bg-secondary px-3">
              <View className="flex-row items-center justify-between border-b-[0.5px] border-hair-soft py-3">
                <Text className="flex-1 pr-3 text-sm font-medium text-foreground" numberOfLines={1}>
                  {org.organizationName}
                </Text>
                {showMoney && (
                  <Pressable
                    onPress={() => {
                      setRenameVisible(true);
                    }}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel="Rename organization"
                    className="active:opacity-70"
                  >
                    <Pencil size={16} color={colors.mutedForeground} />
                  </Pressable>
                )}
              </View>
              {showMoney && (
                <KvRow label="Balance" value={`$${(org.balance / 1_000_000).toFixed(2)}`} />
              )}
              <KvRow label="Seats" value={`${org.seatCount.used} / ${org.seatCount.total}`} last />
            </Animated.View>
          )}
        </Animated.View>

        <OrgUsageStats organizationId={organizationId} />

        <View className="rounded-lg bg-secondary px-3">
          <ConfigureRow
            icon={Users}
            title="Members"
            last={!showMoney}
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/organization/members' as Href);
            }}
          />
          {showMoney && (
            <>
              <ConfigureRow
                icon={Receipt}
                title="Credit activity"
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/organization/credit-activity' as Href);
                }}
              />
              <ConfigureRow
                icon={FileText}
                title="Invoices"
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/organization/invoices' as Href);
                }}
              />
              <ConfigureRow
                icon={Bell}
                title="Low balance alert"
                subtitle={lowBalanceSubtitle}
                last
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/organization/low-balance-alert' as Href);
                }}
              />
            </>
          )}
        </View>
      </ScrollView>

      {renameVisible && org && (
        <RenameOrgModal
          defaultName={org.organizationName}
          onSubmit={name => {
            mutations.rename.mutate(
              { name },
              {
                onSuccess: () => {
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                },
              }
            );
          }}
          onClose={() => {
            setRenameVisible(false);
          }}
        />
      )}
    </View>
  );
}
