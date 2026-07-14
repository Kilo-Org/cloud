import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { type ReactNode, useRef, useState } from 'react';
import { ScrollView, Switch, View } from 'react-native';

import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import {
  emailsError,
  parseEmails,
  parseThreshold,
  thresholdError,
} from '@/components/organization/low-balance-alert-validators';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
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
  const mutations = useOrganizationMutations(organizationId ?? '');
  const { email: myEmail } = useCurrentUserId();

  const [enabled, setEnabled] = useState(settings.minimum_balance !== undefined);
  const thresholdRef = useRef(
    settings.minimum_balance != null ? String(settings.minimum_balance) : ''
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
        <Text className="text-sm font-medium">Enabled</Text>
        <Switch
          accessibilityLabel="Enable low balance alert"
          value={enabled}
          onValueChange={value => {
            void Haptics.selectionAsync();
            setEnabled(value);
            revalidate(value, thresholdRef.current, emailsRef.current);
          }}
        />
      </View>

      {enabled && (
        <>
          <FormField
            label="Alert below (USD)"
            accessibilityLabel="Alert threshold"
            placeholder="10.00"
            keyboardType="decimal-pad"
            defaultValue={thresholdRef.current || undefined}
            validate={thresholdError}
            onChangeText={value => {
              thresholdRef.current = value;
              revalidate(enabled, value, emailsRef.current);
            }}
          />

          <View className="gap-1.5">
            <FormField
              label="Notify emails"
              accessibilityLabel="Notify emails"
              placeholder="name@company.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              defaultValue={emailsRef.current || undefined}
              validate={emailsError}
              onChangeText={value => {
                emailsRef.current = value;
                revalidate(enabled, thresholdRef.current, value);
              }}
            />
            <Text variant="muted" className="text-xs">
              Separate multiple emails with commas.
            </Text>
          </View>
        </>
      )}

      {mutations.updateMinimumBalanceAlert.isError && (
        <Text className="text-sm text-destructive">
          {mutations.updateMinimumBalanceAlert.error.message}
        </Text>
      )}

      <Button
        disabled={!canSave}
        loading={mutations.updateMinimumBalanceAlert.isPending}
        onPress={onSave}
      >
        <Text className="text-primary-foreground">Save</Text>
      </Button>
    </>
  );
}

export function LowBalanceAlertSheet() {
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const orgWithMembers = useOrgWithMembers(organizationId);

  // isPending (no data AND no error) rather than isLoading: an offline
  // paused fetch has isLoading false but no data — it must show the skeleton
  // instead of rendering nothing, while a real error still reaches QueryError.
  // The organizationId guard keeps a disabled query (null org, isPending
  // forever) falling through to OrganizationBoundary below.
  if (isResolving || (organizationId != null && orgWithMembers.isPending)) {
    return (
      <ScrollView className="flex-1 bg-background px-6" contentContainerClassName="gap-6 pb-8 pt-4">
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
    return <PermissionDenied description="You don't have permission to manage billing alerts." />;
  }

  let body: ReactNode = null;
  if (orgWithMembers.data) {
    body = (
      <LowBalanceAlertForm
        organizationId={organizationId}
        settings={orgWithMembers.data.settings}
      />
    );
  } else if (orgWithMembers.isError) {
    body = (
      <QueryError
        onRetry={() => void orgWithMembers.refetch()}
        isRetrying={orgWithMembers.isFetching}
        placement="top"
      />
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background px-6"
      contentContainerClassName="gap-6 pb-8 pt-4"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-center text-lg font-semibold text-foreground">Low balance alert</Text>

      {body}
    </ScrollView>
  );
}
