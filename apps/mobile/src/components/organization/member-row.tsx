import * as Haptics from 'expo-haptics';
import { impactHaptic, notificationHaptic } from '@/lib/haptics';
import { type Href, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { useConfirmDialog } from '@/components/ui/dialog';
import { MenuSheet, type MenuSheetOption } from '@/components/ui/menu-sheet';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { isolateLtrBidiText } from '@/lib/bidi';
import { formatPrefixedMoney } from '@/lib/format';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import { type ActiveOrgMember, type OrgRole } from '@/lib/hooks/use-organization-queries';
import { organizationErrorMessage } from '@/lib/server-error-copy';
import { cn, firstNonEmpty } from '@/lib/utils';

import { type MemberRemovalFailure, removalRefusalMessage } from './member-removal-feedback';
import { assignableMemberRoles } from './organization-role-options';
import { OrganizationPlanRefusal } from './plan-refusal';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { type SurfaceAttempt } from '@/lib/surface-feedback';

type MemberRowProps = {
  member: ActiveOrgMember;
  /** Caller may change this member's role or remove them: management role, not their own, owner rows owner-only. */
  canManage: boolean;
  /** Caller may set this member's daily usage limit. */
  canManageLimit: boolean;
  /** Caller's own organization role; it decides which roles the menu offers. */
  callerRole: OrgRole | undefined;
  enableUsageLimits: boolean;
  /** Organization is a sales demo, so spend may be paired with its limit. */
  isSalesDemo: boolean;
  organizationId: string;
  /** A refused removal for this member, owned by the screen: the optimistic removal unmounts the row, so its own hook cannot carry the failure. */
  removalFailure?: MemberRemovalFailure | null;
  /** The screen's keyed admission for the member id; a refusal settles its attempt. */
  onRemovalStarted?: (memberId: string) => SurfaceAttempt<MemberRemovalFailure> | null;
  /** Retires this member's shown removal refusal; the row calls it when a newer action supersedes it. */
  onRemovalCleared?: (memberId: string) => void;
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

export function MemberRow({
  member,
  canManage,
  canManageLimit,
  callerRole,
  enableUsageLimits,
  isSalesDemo,
  organizationId,
  removalFailure = null,
  onRemovalStarted,
  onRemovalCleared,
}: Readonly<MemberRowProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  // This row renders a refused role change or removal inline (Pattern P2), so
  // the hook's toast stays silent: the same announcement must not leave the
  // row in two places, and the toast cannot win the stacking race against the
  // menu sheet's own window it shares that moment with.
  const mutations = useOrganizationMutations(organizationId, { silenceMemberToast: true });
  const displayName = firstNonEmpty(member.name, member.email);
  // A refused role change is explained from this row's own mutation state; a
  // refused removal comes from the screen's keyed store, because the optimistic
  // removal unmounts this row while its request runs and its hook would die
  // with it. Both name the cause and the owner's next step; the copy comes from
  // the same server mapping the hook's toast used.
  const roleChangeFailure = mutations.updateMember.isError
    ? organizationErrorMessage(mutations.updateMember.error)
    : null;
  const refusalMessage = roleChangeFailure ?? removalFailure?.message ?? null;
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

  const assignableRoles = assignableMemberRoles(callerRole);
  const roleOptions: MenuSheetOption[] = assignableRoles.map(role => ({
    label: roleLabel(role),
    selected: role === member.role,
  }));

  // Each action carries its own gate: a limit-only caller (an admin facing an
  // owner row) still gets a menu, while role change and removal stay
  // owner-only there.
  const actionOptions: MenuSheetOption[] = [
    ...(canManage ? [{ label: t('organization.members.changeRole') }] : []),
    ...(canManageLimit && enableUsageLimits
      ? [{ label: t('organization.members.setDailyUsageLimit') }]
      : []),
    ...(canManage ? [{ label: t('organization.members.removeMember'), destructive: true }] : []),
  ];

  function onSelectRole(role: OrgRole) {
    // A role change is this row's newer action: a refusal the screen still
    // shows from a refused removal describes an attempt the row superseded.
    onRemovalCleared?.(member.id);
    mutations.updateMember.mutate(
      { memberId: member.id, role },
      {
        onSuccess: () => {
          impactHaptic(Haptics.ImpactFeedbackStyle.Light);
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
        // The screen owns the attempt: the optimistic removal unmounts this
        // row, so the refusal a rollback produces must outlive it there.
        if (onRemovalStarted === undefined) {
          mutations.removeMember.mutate(
            { memberId: member.id },
            {
              onSuccess: () => {
                notificationHaptic(Haptics.NotificationFeedbackType.Success);
              },
            }
          );
          return;
        }
        const attempt = onRemovalStarted(member.id);
        // A removal is already running for this member.
        if (attempt === null) {
          return;
        }
        // This row's next action replaces the refusal it showed: a role-change
        // error of a settled attempt must not outlive the removal that
        // superseded it (its state is sticky until the same mutation runs).
        if (mutations.updateMember.isError) {
          mutations.updateMember.reset();
        }
        void (async () => {
          try {
            await mutations.removeMember.mutateAsync({ memberId: member.id });
          } catch (error) {
            attempt.fail({ kind: 'removal-refused', message: removalRefusalMessage(error) });
            return;
          }
          // The row leaving the list is the success outcome itself: the row is
          // gone, the block with it. Nothing is left to render.
          attempt.abandon();
          notificationHaptic(Haptics.NotificationFeedbackType.Success);
        })();
      },
    });
  }

  // Today's spend against the member's own daily limit, on the same terms as
  // web's member card (`DailyUsageLimitDisplay`): the server strips
  // `currentDailyUsageUsd` for a caller whose role may not read other members'
  // usage, and web only pairs the two amounts for a sales-demo organization.
  // Every other case keeps the limit line alone, which every role may see.
  const currentDailyUsageUsd =
    'currentDailyUsageUsd' in member ? member.currentDailyUsageUsd : null;
  // A money amount's symbol is neutral to the paragraph's direction, so each
  // run keeps its own left-to-right order inside the pair.
  const dailyLimit = member.dailyUsageLimitUsd;
  const limitText =
    dailyLimit == null ? null : isolateLtrBidiText(formatPrefixedMoney(dailyLimit, i18n.language));
  const spendText =
    isSalesDemo && currentDailyUsageUsd != null
      ? isolateLtrBidiText(formatPrefixedMoney(currentDailyUsageUsd, i18n.language))
      : null;
  // Web pairs the two amounts only when both exist and the organization is a
  // sales demo; every other case keeps the limit line alone.
  const pairLine = limitText != null && spendText != null ? `${spendText} / ${limitText}` : null;
  const spendLine =
    pairLine ??
    (limitText == null ? null : t('organization.members.limitPerDay', { amount: limitText }));

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
    <View className={cn(ROW_TARGET_CLASS, 'flex-row items-center justify-between gap-3 px-4 py-3')}>
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {displayName}
        </Text>
        <Text variant="caption" className="mt-0.5" numberOfLines={1}>
          {member.email}
        </Text>
      </View>
      <View className="items-end gap-1">
        {/* `font-semibold`, not the medium the small chips use elsewhere: the
            Android Arabic fallback ships Regular and Bold only, so a 500 label
            paints Regular for Arabic while the Latin label gets Roboto Medium,
            and at the caption size that reads as a faded chip. 600 resolves to
            Noto Naskh Arabic Bold, so both scripts carry the same ink. */}
        <View className="rounded-full bg-muted px-2 py-0.5">
          <Text variant="caption" className="font-semibold">
            {roleLabel(member.role)}
          </Text>
        </View>
        {spendLine !== null && <Text variant="caption">{spendLine}</Text>}
      </View>
    </View>
  );

  const refusal = refusalMessage ? (
    <OrganizationPlanRefusal message={refusalMessage} className="mt-2" />
  ) : null;

  // No action at all, so the row is not pressable: a limit-only row still
  // opens the menu.
  if (actionOptions.length === 0) {
    return (
      <View>
        {inner}
        {refusal}
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
        className="active:opacity-70"
      >
        {inner}
        {refusal}
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
          const role = assignableRoles[index];
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
