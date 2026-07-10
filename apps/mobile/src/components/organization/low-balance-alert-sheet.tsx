import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Switch, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import {
  type OrgWithMembers,
  useOrgRole,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { EMAIL_PATTERN } from '@/lib/utils';

function parseThreshold(value: string): number | null {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseEmails(value: string): string[] {
  return value
    .split(',')
    .map(email => email.trim())
    .filter(email => email !== '');
}

type LowBalanceAlertFormProps = Readonly<{
  organizationId: string | null;
  settings: OrgWithMembers['settings'];
}>;

function LowBalanceAlertForm({ organizationId, settings }: LowBalanceAlertFormProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const mutations = useOrganizationMutations(organizationId ?? '');
  const { email: myEmail } = useCurrentUserId();

  const [enabled, setEnabled] = useState(settings.minimum_balance !== undefined);
  const thresholdRef = useRef(
    settings.minimum_balance != null ? String(settings.minimum_balance) : ''
  );
  const emailsRef = useRef((settings.minimum_balance_alert_email ?? []).join(', '));
  const [canSave, setCanSave] = useState(() => {
    const emails = parseEmails(emailsRef.current);
    return (
      !enabled ||
      (parseThreshold(thresholdRef.current) != null &&
        emails.length > 0 &&
        emails.every(email => EMAIL_PATTERN.test(email)))
    );
  });

  const revalidate = (nextEnabled: boolean, thresholdValue: string, emailsValue: string) => {
    const emails = parseEmails(emailsValue);
    setCanSave(
      !nextEnabled ||
        (parseThreshold(thresholdValue) != null &&
          emails.length > 0 &&
          emails.every(email => EMAIL_PATTERN.test(email)))
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
          <View className="gap-2">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              Alert below (USD)
            </Text>
            <TextInput
              accessibilityLabel="Alert threshold"
              className="h-11 rounded-lg bg-secondary px-3 text-sm leading-5 text-foreground"
              placeholder="10.00"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="decimal-pad"
              defaultValue={thresholdRef.current || undefined}
              onChangeText={value => {
                thresholdRef.current = value;
                revalidate(enabled, value, emailsRef.current);
              }}
            />
          </View>

          <View className="gap-2">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              Notify emails
            </Text>
            <TextInput
              accessibilityLabel="Notify emails"
              className="h-11 rounded-lg bg-secondary px-3 text-sm leading-5 text-foreground"
              placeholder={myEmail ?? 'name@company.com'}
              placeholderTextColor={colors.mutedForeground}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              defaultValue={emailsRef.current || undefined}
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

      <Button disabled={!canSave || mutations.updateMinimumBalanceAlert.isPending} onPress={onSave}>
        {mutations.updateMinimumBalanceAlert.isPending ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : null}
        <Text className="text-primary-foreground">Save</Text>
      </Button>
    </>
  );
}

export function LowBalanceAlertSheet() {
  const { organizationId } = useOrgRole();
  const orgWithMembers = useOrgWithMembers(organizationId);

  return (
    <ScrollView
      className="flex-1 bg-background px-6"
      contentContainerClassName="gap-6 pb-8 pt-4"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-center text-lg font-semibold text-foreground">Low balance alert</Text>

      {orgWithMembers.data ? (
        <LowBalanceAlertForm
          organizationId={organizationId}
          settings={orgWithMembers.data.settings}
        />
      ) : (
        <>
          <Skeleton className="h-[52px] rounded-lg" />
          <Skeleton className="h-11 rounded-lg" />
        </>
      )}
    </ScrollView>
  );
}
