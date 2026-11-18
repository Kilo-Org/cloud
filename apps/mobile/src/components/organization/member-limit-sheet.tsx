import { canManageOrganization } from '@kilocode/app-shared/organizations';
import * as Haptics from 'expo-haptics';
import { notificationHaptic } from '@/lib/haptics';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import {
  limitError,
  parseLimit,
  saveErrorCopy,
} from '@/components/organization/member-limit-validators';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { SheetHeader } from '@/components/sheet-header';
import { SheetScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import {
  type ActiveOrgMember,
  isActiveOrgMember,
  type OrgMember,
  useOrgBoundary,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { usePopOnce } from '@/lib/navigation/pop-once';
import { useFormSheetHeaderTopInset } from '@/lib/navigation/sheet-header-top-inset';
import { firstNonEmpty } from '@/lib/utils';

type MemberLimitFormProps = Readonly<{
  memberId: string;
  organizationId: string | null;
  member: ActiveOrgMember;
}>;

function MemberLimitForm({ memberId, organizationId, member }: MemberLimitFormProps) {
  const { t } = useTranslation();
  const closeSheet = usePopOnce();
  const headerTopInset = useFormSheetHeaderTopInset();
  const mutations = useOrganizationMutations(organizationId ?? '', {
    silenceMemberToast: true,
  });
  const currentLimit = member.dailyUsageLimitUsd;
  const hasCurrentLimit = currentLimit != null;

  const initialValue =
    currentLimit == null ? '' : formatNumber(currentLimit, i18n.language, { useGrouping: false });
  const limitRef = useRef(initialValue);
  // Live validation, not FormField's blur-only `validate`: Save is already
  // disabled while the value is invalid, so the reason has to be on screen then,
  // not after the person gives up and taps elsewhere. The message waits for the
  // first edit or blur so the sheet does not open showing an error.
  const [fieldError, setFieldError] = useState<string | null>(() =>
    limitError(initialValue, hasCurrentLimit)
  );
  const [fieldTouched, setFieldTouched] = useState(false);
  const canSave = fieldError === null;
  // A rejected save is rendered in localized copy, never as the server wrote it.
  const saveError = mutations.updateMember.isError
    ? saveErrorCopy(mutations.updateMember.error)
    : null;
  const resetUpdateMember = mutations.updateMember.reset;
  const clearSaveError = () => {
    if (mutations.updateMember.isError) {
      resetUpdateMember();
    }
  };

  const touchedFieldError = fieldTouched ? fieldError : null;
  const limitFieldError = saveError?.field === 'limit' ? saveError.message : touchedFieldError;

  const onSaved = () => {
    notificationHaptic(Haptics.NotificationFeedbackType.Success);
    // The user may have closed the sheet while the write was in flight;
    // popping again would take the screen underneath with it.
    closeSheet();
  };

  const onSave = () => {
    if (!canSave) {
      return;
    }
    const parsed = parseLimit(limitRef.current);
    mutations.updateMember.mutate({ memberId, dailyUsageLimitUsd: parsed }, { onSuccess: onSaved });
  };

  const onRemove = () => {
    mutations.updateMember.mutate({ memberId, dailyUsageLimitUsd: null }, { onSuccess: onSaved });
  };

  return (
    <>
      <SheetHeader
        title={t('organization.memberLimit.title')}
        eyebrow={firstNonEmpty(member.name, member.email)}
        onDone={onSave}
        onCancel={closeSheet}
        doneLabel={t('common.save')}
        doneDisabled={!canSave}
        doneBusy={mutations.updateMember.isPending}
        topInset={headerTopInset}
      />
      <SheetScrollView
        className="flex-1 bg-background"
        contentContainerClassName={SCREEN_BODY_CLASS}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <FormField
          label={t('organization.memberLimit.limitLabel')}
          required
          placeholder={t('organization.memberLimit.noLimitPlaceholder')}
          keyboardType="decimal-pad"
          defaultValue={initialValue || undefined}
          error={limitFieldError ?? undefined}
          onChangeText={value => {
            limitRef.current = value;
            setFieldError(limitError(value, hasCurrentLimit));
            setFieldTouched(true);
            clearSaveError();
          }}
          onBlur={() => {
            setFieldTouched(true);
          }}
        />

        {/* updateMember's toast is silenced for this caller, so AccessibleStatus
            is the single announcement owner: one announcement per platform,
            visuals preserved (tone error). */}
        <AccessibleStatus
          message={saveError?.field === 'form' ? saveError.message : null}
          className="text-sm"
        />

        {currentLimit != null && (
          // Removing the limit keeps the destructive ink and paints no fill of
          // its own: the header's Save stays the only filled control.
          <Button
            variant="outline-destructive"
            disabled={mutations.updateMember.isPending}
            onPress={onRemove}
          >
            {t('organization.memberLimit.removeLimit')}
          </Button>
        )}
      </SheetScrollView>
    </>
  );
}

export function MemberLimitSheet({ memberId }: Readonly<{ memberId: string }>) {
  const { t } = useTranslation();
  const headerTopInset = useFormSheetHeaderTopInset();
  const closeSheet = usePopOnce();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const orgWithMembers = useOrgWithMembers(organizationId);
  const members: OrgMember[] = orgWithMembers.data?.members ?? [];
  const member = members.find(
    (m): m is ActiveOrgMember => isActiveOrgMember(m) && m.id === memberId
  );

  // isPending (no data AND no error) rather than isLoading: an offline paused
  // fetch has isLoading false but no data — it must show the skeleton instead
  // of a settled state until the read answers (reconnect) or the person
  // retries, while a real error still reaches QueryError. The organizationId
  // guard keeps a disabled query (null org, pending forever) falling through
  // to OrganizationBoundary below.
  if (isResolving || (organizationId != null && orgWithMembers.isPending)) {
    return (
      <>
        <SheetHeader
          title={t('organization.memberLimit.title')}
          variant="close"
          onDone={closeSheet}
          topInset={headerTopInset}
        />
        <SheetScrollView
          className="flex-1 bg-background"
          contentContainerClassName={SCREEN_BODY_CLASS}
        >
          <Skeleton className="h-11 rounded-lg" />
        </SheetScrollView>
      </>
    );
  }

  if (organizationId == null || org == null) {
    return <OrganizationBoundary />;
  }

  // The same roles that manage organization members (owner and admin): the
  // server's `organizationMembers.update` limit-only branch is an
  // `organizationAdminMutationProcedure`, and the web members card gates its
  // limit editor on `canManageMembers`.
  if (!canManageOrganization(role)) {
    return (
      <View className="flex-1 bg-background">
        <SheetHeader
          title={t('organization.memberLimit.title')}
          variant="close"
          onDone={closeSheet}
          topInset={headerTopInset}
        />
        <PermissionDenied
          description={t('organization.memberLimit.permissionDenied')}
          showBack={false}
        />
      </View>
    );
  }

  const loadFailed = orgWithMembers.isError && !orgWithMembers.data;
  if (loadFailed || !member) {
    return (
      <>
        {/* Nothing to commit without the member, so the header only closes; a
            failed read still names its retry below. */}
        <SheetHeader
          title={t('organization.memberLimit.title')}
          variant="close"
          onDone={closeSheet}
          topInset={headerTopInset}
        />
        {loadFailed ? (
          <QueryError
            className="bg-background"
            onRetry={() => void orgWithMembers.refetch()}
            isRetrying={orgWithMembers.isFetching}
          />
        ) : (
          <CenteredState className="bg-background" contentContainerClassName="px-4">
            <Text variant="muted" className="text-center">
              {t('organization.memberLimit.memberNotFound')}
            </Text>
          </CenteredState>
        )}
      </>
    );
  }

  return <MemberLimitForm memberId={memberId} organizationId={organizationId} member={member} />;
}
