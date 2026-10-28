import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { useConfirmDialog } from '@/components/ui/dialog';
import { MenuSheet, type MenuSheetOption } from '@/components/ui/menu-sheet';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatMoney } from '@/lib/format';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import { type ActiveOrgMember, type OrgRole } from '@/lib/hooks/use-organization-queries';
import { cn, firstNonEmpty } from '@/lib/utils';

type MemberRowProps = {
  member: ActiveOrgMember;
  /** Caller is owner and this isn't their own row. */
  canManage: boolean;
  enableUsageLimits: boolean;
  organizationId: string;
  /** Suppress bottom divider on the last row of a group. */
  last?: boolean;
};

const ROLE_LABEL_KEYS = {
  owner: 'organization.members.roles.owner',
  admin: 'organization.members.roles.admin',
  member: 'organization.members.roles.member',
  billing_manager: 'organization.members.roles.billingManager',
} as const;

export function roleLabel(role: OrgRole): string {
  return i18n.t(ROLE_LABEL_KEYS[role]);
}

const ROLE_OPTIONS: OrgRole[] = ['owner', 'admin', 'member', 'billing_manager'];

export function MemberRow({
  member,
  canManage,
  enableUsageLimits,
  organizationId,
  last,
}: Readonly<MemberRowProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const mutations = useOrganizationMutations(organizationId);
  const displayName = firstNonEmpty(member.name, member.email);
  const [menu, setMenu] = useState<'actions' | 'role' | null>(null);
  // The action a chosen row will run once its menu is gone. The menu's window
  // owns the back key until it finishes dismissing, so running the choice only
  // after that keeps a Back press in that window a real cancel instead of a
  // race with the route it is opening.
  const pendingActionRef = useRef<(() => void) | null>(null);
  const menuDismissedItselfRef = useRef(false);

  function runPendingAction() {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    const dismissedItself = menuDismissedItselfRef.current;
    menuDismissedItselfRef.current = false;
    if (action && !dismissedItself) {
      action();
    }
  }

  function chooseAction(action: () => void) {
    pendingActionRef.current = action;
    menuDismissedItselfRef.current = false;
    setMenu(null);
  }

  function markMenuDismissedItself() {
    menuDismissedItselfRef.current = true;
    return true;
  }

  const roleOptions: MenuSheetOption[] = ROLE_OPTIONS.map(role => ({
    label: roleLabel(role),
    selected: role === member.role,
  }));

  const actionOptions: MenuSheetOption[] = [
    { label: t('organization.members.changeRole') },
    ...(enableUsageLimits ? [{ label: t('organization.members.setDailyUsageLimit') }] : []),
    { label: t('organization.members.removeMember'), destructive: true },
  ];

  function onSelectRole(role: OrgRole) {
    mutations.updateMember.mutate(
      { memberId: member.id, role },
      {
        onSuccess: () => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
      }
    );
  }

  function confirmRemove() {
    confirm({
      title: t('organization.members.removeMember'),
      message: t('organization.members.removeMemberMessage', { name: displayName }),
      confirmLabel: t('common.remove'),
      onConfirm: () => {
        mutations.removeMember.mutate(
          { memberId: member.id },
          {
            onSuccess: () => {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            },
          }
        );
      },
    });
  }

  function actionFor(index: number): (() => void) | null {
    const label = actionOptions[index]?.label;
    if (label === t('organization.members.changeRole')) {
      return () => {
        setMenu('role');
      };
    }
    if (label === t('organization.members.setDailyUsageLimit')) {
      return () => {
        router.push(
          `/(app)/(tabs)/(3_profile)/organization/member-limit?memberId=${member.id}` as Href
        );
      };
    }
    if (label === t('organization.members.removeMember')) {
      return confirmRemove;
    }
    return null;
  }

  const inner = (
    <View
      className={cn(
        'flex-row items-center justify-between gap-3 py-3',
        !last && 'border-b-[0.5px] border-hair-soft'
      )}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {displayName}
        </Text>
        <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          {member.email}
        </Text>
      </View>
      <View className="items-end gap-1">
        <View className="rounded-full bg-muted px-2 py-0.5">
          <Text className="text-[11px] font-medium text-muted-foreground">
            {roleLabel(member.role)}
          </Text>
        </View>
        {member.dailyUsageLimitUsd != null && (
          <Text className="text-xs text-muted-foreground">
            {t('organization.members.limitPerDay', {
              amount: formatMoney(member.dailyUsageLimitUsd, i18n.language),
            })}
          </Text>
        )}
      </View>
    </View>
  );

  if (!canManage) {
    return (
      <View className="px-3">
        {inner}
        {dialog}
      </View>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => {
          setMenu('actions');
        }}
        accessibilityRole="button"
        accessibilityLabel={t('organization.members.manageA11y', { name: displayName })}
        className="px-3 active:opacity-70"
      >
        {inner}
        {dialog}
      </Pressable>
      <MenuSheet
        visible={menu === 'actions'}
        title={displayName}
        options={actionOptions}
        cancelLabel={t('common.cancel')}
        onClose={() => {
          setMenu(null);
        }}
        onDismiss={runPendingAction}
        onRequestDismiss={markMenuDismissedItself}
        onSelect={index => {
          const action = actionFor(index);
          if (action) {
            chooseAction(action);
          }
        }}
      />
      <MenuSheet
        visible={menu === 'role'}
        title={t('organization.members.changeRole')}
        options={roleOptions}
        cancelLabel={t('common.cancel')}
        onClose={() => {
          setMenu(null);
        }}
        onDismiss={runPendingAction}
        onRequestDismiss={markMenuDismissedItself}
        onSelect={index => {
          const role = ROLE_OPTIONS[index];
          if (role) {
            chooseAction(() => {
              onSelectRole(role);
            });
          }
        }}
      />
    </>
  );
}
