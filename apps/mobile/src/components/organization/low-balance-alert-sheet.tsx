import * as Haptics from 'expo-haptics';
import { notificationHaptic } from '@/lib/haptics';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import {
  emailsError,
  parseEmails,
  parseThreshold,
  saveErrorCopy,
  thresholdError,
} from '@/components/organization/low-balance-alert-validators';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { SheetScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { INPUT_BOX_SHAPE_CLASS } from '@/components/ui/input';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import {
  isMoneyRole,
  type OrgWithMembers,
  useOrgBoundary,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';

type LowBalanceAlertFormProps = Readonly<{
  organizationId: string | null;
  settings: OrgWithMembers['settings'];
}>;

/** The field's and the save button's own 44pt box under the loading fill. */
const SAVE_BAR_CLASS = 'w-full rounded-md bg-muted-soft';

function LowBalanceAlertForm({ organizationId, settings }: LowBalanceAlertFormProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const mutations = useOrganizationMutations(organizationId ?? '');
  const { email: myEmail } = useCurrentUserId();

  const [enabled, setEnabled] = useState(settings.minimum_balance !== undefined);
  const thresholdRef = useRef(
    settings.minimum_balance == null
      ? ''
      : formatNumber(settings.minimum_balance, i18n.language, { useGrouping: false })
  );
  // Default to the signer's own email when no alert email is stored yet, so
  // the field starts pre-filled with a real, savable value rather than a
  // placeholder that looks filled in but saves as empty.
  const emailsRef = useRef(
    (settings.minimum_balance_alert_email ?? (myEmail ? [myEmail] : [])).join(', ')
  );
  const [canSave, setCanSave] = useState(
    () =>
      !enabled ||
      (thresholdError(thresholdRef.current) == null && emailsError(emailsRef.current) == null)
  );

  // The field's own rule runs on blur, and on change only once it has
  // something to say. Save follows every keystroke, so an amount pasted above
  // the ceiling would otherwise sit under a disabled Save with nothing under the
  // field explaining it. Seeding the same rule on change keeps the sentence with
  // the draft; an empty field still waits for blur, so a form that opens empty
  // does not greet the reader with a required error.
  const fieldThresholdError = (value: string) =>
    value.trim() === '' ? null : thresholdError(value);
  const [draftThresholdError, setDraftThresholdError] = useState(() =>
    fieldThresholdError(thresholdRef.current)
  );

  const revalidate = (nextEnabled: boolean, thresholdValue: string, emailsValue: string) => {
    setCanSave(
      !nextEnabled || (thresholdError(thresholdValue) == null && emailsError(emailsValue) == null)
    );
  };

  // A rejected save belongs to the field that caused it; correcting either
  // field drops the rejection so Save no longer sits under a stale sentence.
  const saveError = mutations.updateMinimumBalanceAlert.isError
    ? saveErrorCopy(mutations.updateMinimumBalanceAlert.error)
    : null;
  const clearSaveError = () => {
    if (mutations.updateMinimumBalanceAlert.isError) {
      mutations.updateMinimumBalanceAlert.reset();
    }
  };

  const onSave = () => {
    const threshold = parseThreshold(thresholdRef.current);
    const emails = parseEmails(emailsRef.current);
    if (enabled && (threshold == null || emails.length === 0 || !canSave)) {
      return;
    }
    mutations.updateMinimumBalanceAlert.mutate(
      {
        enabled,
        ...(enabled && threshold != null
          ? { minimum_balance: threshold, minimum_balance_alert_email: emails }
          : {}),
      },
      {
        onSuccess: () => {
          notificationHaptic(Haptics.NotificationFeedbackType.Success);
          router.back();
        },
      }
    );
  };

  return (
    <>
      <RowGroup>
        <PreferenceRow
          title={t('organization.lowBalanceAlert.enableA11y')}
          value={enabled}
          disabled={false}
          onValueChange={value => {
            setEnabled(value);
            setDraftThresholdError(value ? fieldThresholdError(thresholdRef.current) : null);
            revalidate(value, thresholdRef.current, emailsRef.current);
            clearSaveError();
          }}
        />
      </RowGroup>

      {enabled && (
        <>
          <FormField
            label={t('organization.lowBalanceAlert.thresholdLabel')}
            required
            placeholder={t('organization.lowBalanceAlert.thresholdPlaceholder')}
            keyboardType="decimal-pad"
            defaultValue={thresholdRef.current || undefined}
            validate={thresholdError}
            error={draftThresholdError ?? undefined}
            onChangeText={value => {
              thresholdRef.current = value;
              setDraftThresholdError(fieldThresholdError(value));
              revalidate(enabled, value, emailsRef.current);
              clearSaveError();
            }}
          />

          <View className="gap-1.5">
            <FormField
              label={t('organization.lowBalanceAlert.notifyEmailsLabel')}
              required
              placeholder={t('organization.inviteMember.emailPlaceholder')}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              defaultValue={emailsRef.current || undefined}
              validate={emailsError}
              onChangeText={value => {
                emailsRef.current = value;
                revalidate(enabled, thresholdRef.current, value);
                clearSaveError();
              }}
            />
            <Text variant="caption">{t('organization.lowBalanceAlert.separateEmailsHint')}</Text>
            <AccessibleStatus
              message={saveError?.field === 'emails' ? saveError.message : null}
              className="text-sm"
            />
          </View>
        </>
      )}

      {/* updateMinimumBalanceAlert has no mutation toast (inline error pattern
          P2), so AccessibleStatus is the single announcement owner here: one
          announcement per platform, visuals preserved (tone error). A rejected
          save names itself in localized copy — the server's schema message is
          a JSON array, never a sentence a person should read. */}
      <AccessibleStatus
        message={saveError?.field === 'form' ? saveError.message : null}
        className="text-sm"
      />

      <Button
        disabled={!canSave}
        loading={mutations.updateMinimumBalanceAlert.isPending}
        onPress={onSave}
      >
        <Text>{t('common.save')}</Text>
      </Button>
    </>
  );
}

export function LowBalanceAlertSheet() {
  const { t } = useTranslation();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const orgWithMembers = useOrgWithMembers(organizationId);

  // isPending (no data AND no error) rather than isLoading: an offline
  // paused fetch has isLoading false but no data — it must show the skeleton
  // instead of rendering nothing, while a real error still reaches QueryError.
  // The organizationId guard keeps a disabled query (null org, isPending
  // forever) falling through to OrganizationBoundary below.
  if (isResolving || (organizationId != null && orgWithMembers.isPending)) {
    return (
      <SheetScrollView
        className="flex-1 bg-background"
        contentContainerClassName={SCREEN_BODY_CLASS}
      >
        <RowGroup>
          <RowSkeleton trailing="switch" />
        </RowGroup>
        <View className="gap-1.5">
          <Skeleton className="h-3.5 w-28 rounded" />
          <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, SAVE_BAR_CLASS)} />
        </View>
        <View className="gap-1.5">
          <Skeleton className="h-3.5 w-32 rounded" />
          <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, SAVE_BAR_CLASS)} />
        </View>
        <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, SAVE_BAR_CLASS)} />
      </SheetScrollView>
    );
  }
  if (organizationId == null || org == null) {
    return <OrganizationBoundary />;
  }
  if (!isMoneyRole(role)) {
    return <PermissionDenied description={t('organization.lowBalanceAlert.permissionDenied')} />;
  }

  if (orgWithMembers.isError && !orgWithMembers.data) {
    return (
      <>
        <View collapsable={false} className="bg-background px-4 pt-3">
          <Text variant="large" className="text-center">
            {t('organization.lowBalanceAlert.title')}
          </Text>
        </View>
        <QueryError
          className="bg-background"
          onRetry={() => void orgWithMembers.refetch()}
          isRetrying={orgWithMembers.isFetching}
        />
      </>
    );
  }

  return (
    <SheetScrollView
      className="flex-1 bg-background"
      contentContainerClassName={SCREEN_BODY_CLASS}
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Text variant="large" className="text-center">
        {t('organization.lowBalanceAlert.title')}
      </Text>

      {orgWithMembers.data && (
        <LowBalanceAlertForm
          organizationId={organizationId}
          settings={orgWithMembers.data.settings}
        />
      )}
    </SheetScrollView>
  );
}
