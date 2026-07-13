import { formatDollars, fromMicrodollars } from '@kilocode/app-shared/utils';
import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { Bell, FileText, Pencil, Receipt, Users } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { AddCreditsRow } from '@/components/add-credits-row';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { OrgUsageStats } from '@/components/organization/org-usage-stats';
import { RenameModal } from '@/components/rename-modal';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { KvRow } from '@/components/ui/kv-row';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { WEB_BASE_URL } from '@/lib/config';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import {
  isMoneyRole,
  useOrgBoundary,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function OrganizationHubScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const orgWithMembers = useOrgWithMembers(organizationId);
  const mutations = useOrganizationMutations(organizationId ?? '');
  const [renameVisible, setRenameVisible] = useState(false);

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title="Organization" />;
  }

  const showMoney = isMoneyRole(role);
  const minimumBalance = orgWithMembers.data?.settings.minimum_balance;
  const lowBalanceSubtitle =
    minimumBalance != null ? `Below ${formatDollars(minimumBalance)}` : 'Off';

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={org.organizationName} />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
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
            <KvRow label="Balance" value={formatDollars(fromMicrodollars(org.balance))} />
          )}
          {showMoney && org.balance === 0 && (
            <AddCreditsRow
              url={`${WEB_BASE_URL}/organizations/${organizationId}/payment-details`}
              className="border-b-[0.5px] border-hair-soft py-3"
            />
          )}
          <KvRow
            label="Seats"
            // `requireSeats` is the enforcement switch; total is the raw
            // purchased capacity and can legitimately be zero.
            value={
              org.requireSeats
                ? `${org.seatCount.used} / ${org.seatCount.total}`
                : String(org.seatCount.used)
            }
            last
          />
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
      </TabScreenScrollView>

      {renameVisible && (
        <RenameModal
          title="Rename organization"
          placeholder="Enter organization name"
          initialValue={org.organizationName}
          onSave={async name => {
            await mutations.rename.mutateAsync({ name });
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
          onClose={() => {
            setRenameVisible(false);
          }}
        />
      )}
    </View>
  );
}
