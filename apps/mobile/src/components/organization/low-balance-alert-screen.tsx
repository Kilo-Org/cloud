import * as Haptics from 'expo-haptics';
import { notificationHaptic } from '@/lib/haptics';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import {
  emailsError,
  parseEmails,
  parseThreshold,
  saveErrorCopy,
  type SaveErrorCopy,
  thresholdError,
} from '@/components/organization/low-balance-alert-validators';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
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
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';
import { cn } from '@/lib/utils';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import {
  isMoneyRole,
  type OrgWithMembers,
  useOrgBoundary,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';

/** The payload every commit of this form posts. */
type LowBalanceAlertInput = Readonly<{
  enabled: boolean;
  minimum_balance?: number;
  minimum_balance_alert_email?: string[];
}>;

/** A rejected commit: where its sentence belongs, and what to retry. */
type SaveFailure = SaveErrorCopy & Readonly<{ input: LowBalanceAlertInput }>;

type LowBalanceAlertFormProps = Readonly<{
  organizationId: string;
  settings: OrgWithMembers['settings'];
}>;

/** The field's own 44pt box under the loading fill. */
const FIELD_FILL_CLASS = 'w-full rounded-md bg-muted-soft';

/**
 * The field's rule while the person is still typing: a blank field waits for
 * the commit that asks for it, a filled one reports on the keystroke so an
 * amount pasted above the ceiling never sits unexplained.
 */
function liveThresholdError(value: string): string | null {
  return value.trim() === '' ? null : thresholdError(value);
}

/**
 * The alert's switch, threshold and recipients commit themselves, like Spend
 * alerts: the switch writes at once (on only when the fields are valid), the
 * fields write on blur and on the keyboard's submit under the same all-valid
 * rule. A rejected write keeps the draft and names itself inline with a Retry.
 */
function LowBalanceAlertForm({ organizationId, settings }: LowBalanceAlertFormProps) {
  const { t } = useTranslation();
  const saveMutation = useOrganizationMutations(organizationId).updateMinimumBalanceAlert;
  const { email: myEmail } = useCurrentUserId();

  // The draft lives in refs (iOS: never control an input with state); the
  // switch and the messages are state because they render their own value.
  const [enabled, setEnabledState] = useState(settings.minimum_balance !== undefined);
  const enabledRef = useRef(enabled);
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
  const [thresholdDraftError, setThresholdDraftError] = useState<string | null>(() =>
    liveThresholdError(thresholdRef.current)
  );
  const [emailsDraftError, setEmailsDraftError] = useState<string | null>(null);

  // Success and the rejected-write line are real Text nodes (AccessibleStatus),
  // not toasts: sonner-native draws outside the accessibility hierarchy, and a
  // toast-only sentence never reaches assistive tech.
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [saving, setSaving] = useState(false);

  // One request at a time. Every draft edit bumps the version, and a response
  // only paints when it still describes the values on screen, so a late answer
  // can never confirm or fail a newer draft; a commit asked for while a request
  // is in flight runs once that request settles.
  const draftVersion = useRef(0);
  const inFlight = useRef(false);
  const maskedCommit = useRef(false);

  function editDraft() {
    draftVersion.current += 1;
    setSaved(false);
    setFailure(null);
  }

  /**
   * What this draft would post, or `null` when the enabled alert is missing a
   * valid value — in which case both fields name their own problem and nothing
   * is stored.
   */
  function buildInput(): LowBalanceAlertInput | null {
    if (!enabledRef.current) {
      return { enabled: false };
    }
    const threshold = parseThreshold(thresholdRef.current);
    const recipients = parseEmails(emailsRef.current);
    if (threshold == null || recipients.length === 0 || emailsError(emailsRef.current) != null) {
      setThresholdDraftError(thresholdError(thresholdRef.current) || null);
      setEmailsDraftError(emailsError(emailsRef.current));
      return null;
    }
    return {
      enabled: true,
      minimum_balance: threshold,
      minimum_balance_alert_email: recipients,
    };
  }

  function submit() {
    const input = buildInput();
    if (input != null) {
      send(input);
    }
  }

  function send(input: LowBalanceAlertInput) {
    if (inFlight.current) {
      maskedCommit.current = true;
      return;
    }
    inFlight.current = true;
    setSaving(true);
    const version = draftVersion.current;
    saveMutation.mutate(input, {
      onSuccess: () => {
        settle(version, () => {
          notificationHaptic(Haptics.NotificationFeedbackType.Success);
          setSaved(true);
        });
      },
      onError: error => {
        settle(version, () => {
          setFailure({ ...saveErrorCopy(error), input });
        });
      },
    });
  }

  function settle(version: number, apply: () => void) {
    inFlight.current = false;
    setSaving(false);
    if (draftVersion.current === version) {
      apply();
    }
    if (maskedCommit.current) {
      maskedCommit.current = false;
      // The settled request already wrote the version it carried; only a draft
      // that moved on needs a second one.
      if (draftVersion.current !== version) {
        submit();
      }
    }
  }

  // The error is announced once: under the recipients when the server rejected
  // an address and the field is on screen, otherwise on the form line. The
  // rejected sentence keeps priority over a last confirmation.
  const failureOnEmails = failure != null && failure.field === 'emails' && enabled;
  const saveFailureHere = failureOnEmails ? failure.message : null;
  const saveFailureOnForm = failure != null && !failureOnEmails ? failure.message : null;

  return (
    <>
      <RowGroup>
        <PreferenceRow
          title={t('organization.lowBalanceAlert.enableA11y')}
          value={enabled}
          disabled={false}
          onValueChange={value => {
            editDraft();
            enabledRef.current = value;
            setEnabledState(value);
            setThresholdDraftError(value ? liveThresholdError(thresholdRef.current) : null);
            if (!value) {
              setEmailsDraftError(null);
            }
            submit();
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
            error={thresholdDraftError ?? undefined}
            onChangeText={value => {
              thresholdRef.current = value;
              editDraft();
              setThresholdDraftError(liveThresholdError(value));
            }}
            onBlur={submit}
            onSubmitEditing={submit}
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
              error={emailsDraftError ?? undefined}
              onChangeText={value => {
                emailsRef.current = value;
                editDraft();
                setEmailsDraftError(null);
              }}
              onBlur={submit}
              onSubmitEditing={submit}
            />
            <Text variant="caption">{t('organization.lowBalanceAlert.separateEmailsHint')}</Text>
            <AccessibleStatus message={saveFailureHere} tone="error" className="text-sm" />
          </View>
        </>
      )}

      {/* The error is announced once: under the recipients when the server
          rejected an address, otherwise here. A failure outranks the last
          confirmation, and the Retry resends the rejected write so it cannot
          drift from the values that failed. */}
      {saveFailureOnForm != null && (
        <AccessibleStatus message={saveFailureOnForm} tone="error" className="text-sm" />
      )}
      {saved && (
        <AccessibleStatus
          message={t('organizationGuardrails.statusSaved')}
          tone="status"
          className="text-sm"
        />
      )}
      {failure != null && (
        <Button
          variant="outline"
          accessibilityLabel={t('common.retry')}
          loading={saving}
          onPress={() => {
            send(failure.input);
          }}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      )}
    </>
  );
}

export function LowBalanceAlertScreen() {
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
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('organization.lowBalanceAlert.title')}
          backFallback={ORGANIZATION_HUB_PATH}
        />
        <TabScreenScrollView
          className="flex-1"
          contentContainerClassName={SCREEN_BODY_CLASS}
          showsVerticalScrollIndicator={false}
        >
          <RowGroup>
            <RowSkeleton trailing="switch" />
          </RowGroup>
          <View className="gap-1.5">
            <Skeleton className="h-3.5 w-28 rounded" />
            <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, FIELD_FILL_CLASS)} />
          </View>
          <View className="gap-1.5">
            <Skeleton className="h-3.5 w-32 rounded" />
            <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, FIELD_FILL_CLASS)} />
          </View>
        </TabScreenScrollView>
      </View>
    );
  }
  if (organizationId == null || org == null) {
    return (
      <OrganizationBoundary
        title={t('organization.lowBalanceAlert.title')}
        backFallback={ORGANIZATION_HUB_PATH}
      />
    );
  }
  if (!isMoneyRole(role)) {
    return <PermissionDenied description={t('organization.lowBalanceAlert.permissionDenied')} />;
  }

  if (orgWithMembers.isError && !orgWithMembers.data) {
    return (
      <View className="flex-1 bg-background">
        {/* Nothing to commit until the read answers, so the header only goes
            back; the retry lives in the error block below. */}
        <ScreenHeader
          title={t('organization.lowBalanceAlert.title')}
          backFallback={ORGANIZATION_HUB_PATH}
        />
        <QueryError
          className="bg-background"
          onRetry={() => void orgWithMembers.refetch()}
          isRetrying={orgWithMembers.isFetching}
        />
      </View>
    );
  }

  if (!orgWithMembers.data) {
    return null;
  }
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('organization.lowBalanceAlert.title')}
        backFallback={ORGANIZATION_HUB_PATH}
      />
      <TabScreenScrollView
        // iOS IME inset and focused-field auto-reveal (AGENTS.md: input screens).
        automaticallyAdjustKeyboardInsets
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <LowBalanceAlertForm
          organizationId={organizationId}
          settings={orgWithMembers.data.settings}
        />
      </TabScreenScrollView>
    </View>
  );
}
