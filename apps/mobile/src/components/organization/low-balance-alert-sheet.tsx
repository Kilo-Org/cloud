import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Switch, View } from 'react-native';

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
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
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
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.back();
        },
      }
    );
  };

  return (
    <>
      <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
        <Text className="text-sm font-medium">{t('common.enabled')}</Text>
        <Switch
          accessibilityLabel={t('organization.lowBalanceAlert.enableA11y')}
          value={enabled}
          onValueChange={value => {
            void Haptics.selectionAsync();
            setEnabled(value);
            revalidate(value, thresholdRef.current, emailsRef.current);
            clearSaveError();
          }}
        />
      </View>

      {enabled && (
        <>
          <FormField
            label={t('organization.lowBalanceAlert.thresholdLabel')}
            required
            placeholder={t('organization.lowBalanceAlert.thresholdPlaceholder')}
            keyboardType="decimal-pad"
            defaultValue={thresholdRef.current || undefined}
            validate={thresholdError}
            onChangeText={value => {
              thresholdRef.current = value;
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
            <Text variant="muted" className="text-xs">
              {t('organization.lowBalanceAlert.separateEmailsHint')}
            </Text>
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
        <Text className="text-primary-foreground">{t('common.save')}</Text>
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
      <ScrollView className="flex-1 bg-background" contentContainerClassName="px-6 gap-6 pb-8 pt-4">
        <Skeleton className="h-[52px] rounded-lg" />
        <View className="gap-1.5">
          <Skeleton className="h-3.5 w-28 rounded" />
          <Skeleton className="h-11 rounded-md" />
        </View>
        <View className="gap-1.5">
          <Skeleton className="h-3.5 w-32 rounded" />
          <Skeleton className="h-11 rounded-md" />
        </View>
        <Skeleton className="h-11 rounded-md" />
      </ScrollView>
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
        <View collapsable={false} className="bg-background px-6 pt-4">
          <Text className="text-center text-lg font-semibold text-foreground">
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
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="px-6 gap-6 pb-8 pt-4"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-center text-lg font-semibold text-foreground">
        {t('organization.lowBalanceAlert.title')}
      </Text>

      {orgWithMembers.data && (
        <LowBalanceAlertForm
          organizationId={organizationId}
          settings={orgWithMembers.data.settings}
        />
      )}
    </ScrollView>
  );
}
