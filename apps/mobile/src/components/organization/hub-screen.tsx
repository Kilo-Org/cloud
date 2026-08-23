import { formatDollars, fromMicrodollars } from '@kilocode/app-shared/utils';
import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { Bell, ChevronRight, FileText, Pencil, Receipt, Users } from '@/components/ui/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { AddCreditsRow } from '@/components/add-credits-row';
import { KiloPassIcon } from '@/components/kilo-pass/kilo-pass-icon';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import {
  getOrgKiloPassRowState,
  type OrgKiloPassRowState,
} from '@/components/organization/org-kilo-pass-row-state';
import { OrgUsageStats } from '@/components/organization/org-usage-stats';
import { RenameModal } from '@/components/rename-modal';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { KvRow } from '@/components/ui/kv-row';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { agentColor, type Tint, toneColor } from '@/lib/agent-color';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import {
  isMoneyRole,
  useOrgBoundary,
  useOrgKiloPassSummary,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

export function OrganizationHubScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const orgWithMembers = useOrgWithMembers(organizationId);
  // The summary API is parent-only (`organizationParentBillingProcedure`
  // rejects child orgs and non-billing roles), so a child org must never fire
  // it — gate on the loaded membership payload, not just the role.
  const showKiloPass = isMoneyRole(role) && orgWithMembers.data?.parent_organization_id === null;
  const kiloPassSummary = useOrgKiloPassSummary(organizationId, showKiloPass);
  const mutations = useOrganizationMutations(organizationId ?? '');
  const [renameVisible, setRenameVisible] = useState(false);
  const { t } = useTranslation();

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t('organization.hub.title')} />;
  }

  const showMoney = isMoneyRole(role);
  const kiloPassRowState = showKiloPass
    ? getOrgKiloPassRowState({ data: kiloPassSummary.data, isError: kiloPassSummary.isError })
    : null;
  const kiloPassManagementUrl = `${WEB_BASE_URL}/organizations/${organizationId}/subscriptions/kilo-pass`;
  const kiloPassSetupUrl = `${kiloPassManagementUrl}/setup`;
  const minimumBalance = orgWithMembers.data?.settings.minimum_balance;
  const lowBalanceSubtitle =
    minimumBalance != null
      ? t('organization.hub.lowBalanceBelow', { amount: formatDollars(minimumBalance) })
      : t('organization.hub.lowBalanceOff');

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
                accessibilityLabel={t('organization.hub.renameTitle')}
                className="active:opacity-70"
              >
                <Pencil size={16} color={colors.mutedForeground} />
              </Pressable>
            )}
          </View>
          {showMoney && (
            <KvRow
              label={t('organization.hub.balance')}
              value={formatDollars(fromMicrodollars(org.balance))}
            />
          )}
          {showMoney && org.balance === 0 && (
            <AddCreditsRow
              url={`${WEB_BASE_URL}/organizations/${organizationId}/payment-details`}
              className="border-b-[0.5px] border-hair-soft py-3"
            />
          )}
          <KvRow
            label={t('organization.hub.organizationSeats')}
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
            title={t('organization.members.title')}
            last={!showMoney}
            onPress={() => {
              router.push('/(app)/(tabs)/(3_profile)/organization/members' as Href);
            }}
          />
          {showMoney && (
            <>
              <ConfigureRow
                icon={Receipt}
                title={t('organization.creditActivity.title')}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/organization/credit-activity' as Href);
                }}
              />
              <ConfigureRow
                icon={FileText}
                title={t('organization.invoices.title')}
                onPress={() => {
                  router.push('/(app)/(tabs)/(3_profile)/organization/invoices' as Href);
                }}
              />
              {kiloPassRowState != null && (
                <OrgKiloPassRow
                  state={kiloPassRowState}
                  onManage={() => {
                    void openExternalUrl(kiloPassManagementUrl, {
                      label: t('kiloPass.kiloPassManagement'),
                    });
                  }}
                  onSetup={() => {
                    void openExternalUrl(kiloPassSetupUrl, {
                      label: t('kiloPass.kiloPassSetup'),
                    });
                  }}
                  onRetry={() => {
                    void kiloPassSummary.refetch();
                  }}
                />
              )}
              <ConfigureRow
                icon={Bell}
                title={t('organization.lowBalanceAlert.title')}
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
          title={t('organization.hub.renameTitle')}
          placeholder={t('organization.hub.renamePlaceholder')}
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

type OrgKiloPassRowProps = Readonly<{
  state: OrgKiloPassRowState;
  onManage: () => void;
  onSetup: () => void;
  onRetry: () => void;
}>;

/**
 * Compact Kilo Pass for Orgs row in the billing configuration group. Mirrors
 * ConfigureRow's layout and divider, but renders KiloPassIcon directly (it is
 * a plain function component, not a LucideIcon) and sets explicit
 * accessibility roles/labels for the manage, setup, and retry actions. Never
 * the last row — "Low balance alert" always follows it — so the divider is
 * permanent.
 */
function OrgKiloPassRow({ state, onManage, onSetup, onRetry }: OrgKiloPassRowProps) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const tint: Tint = state.attention ? toneColor('warn') : agentColor('Kilo Pass');
  let onPress: (() => void) | null = null;
  if (state.action === 'manage') {
    onPress = onManage;
  } else if (state.action === 'setup') {
    onPress = onSetup;
  } else if (state.action === 'retry') {
    onPress = onRetry;
  }
  const opensWeb = state.action === 'manage' || state.action === 'setup';
  const accessibilityLabel = state.actionLabel
    ? `${t('kiloPass.title')}. ${state.subtitle}. ${state.actionLabel}`
    : `${t('kiloPass.title')}. ${state.subtitle}`;

  const inner = (
    <View className="flex-row items-center gap-3 border-b-[0.5px] border-hair-soft py-3">
      <View
        className={cn(
          'h-[30px] w-[30px] items-center justify-center rounded-lg border',
          tint.tileBgClass,
          tint.tileBorderClass
        )}
      >
        <KiloPassIcon size={16} color={colors[tint.hueThemeKey]} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground">{t('kiloPass.title')}</Text>
        <Text className="mt-0.5 text-xs text-muted-foreground">{state.subtitle}</Text>
      </View>
      {state.action === 'retry' ? (
        <Text className="shrink-0 text-xs font-medium text-primary">{state.actionLabel}</Text>
      ) : null}
      {opensWeb ? <ChevronRight size={14} color={colors.mutedForeground} /> : null}
    </View>
  );

  if (onPress == null) {
    return (
      <View accessibilityLabel={accessibilityLabel} accessibilityState={{ busy: state.loading }}>
        {inner}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={state.accessibilityHint ?? undefined}
      className="active:opacity-70"
    >
      {inner}
    </Pressable>
  );
}
