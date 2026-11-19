import * as Haptics from 'expo-haptics';
import { notificationHaptic } from '@/lib/haptics';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  emailsError,
  emailsErrorMessages,
  parseEmails,
  parseThreshold,
  saveErrorCopy,
  thresholdError,
  thresholdErrorMessages,
} from '@/components/organization/low-balance-alert-validators';
import { RefusalStatus } from '@/components/refusal-status';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowGroup } from '@/components/ui/row-group';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import { type OrgWithMembers } from '@/lib/hooks/use-organization-queries';
import { isTrialExpiredRefusal } from '@/lib/server-error-copy';
import { useTrialRefusalAction } from '@/lib/trial-refusal';

/** The payload every commit of this form posts. */
type LowBalanceAlertInput = Readonly<{
  enabled: boolean;
  minimum_balance?: number;
  minimum_balance_alert_email?: string[];
}>;

/** A rejected commit: the raw rejection, and what to retry. */
type SaveFailure = Readonly<{ error: unknown; input: LowBalanceAlertInput }>;

/**
 * The last commit's outcome, as one value: a confirmation and a rejected write
 * cannot paint together, because a new outcome replaces the previous one
 * instead of setting a second flag.
 */
type SaveOutcome =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'saved' }>
  | Readonly<{ kind: 'failed'; failure: SaveFailure }>;

type LowBalanceAlertFormProps = Readonly<{
  organizationId: string;
  settings: OrgWithMembers['settings'];
  /** Whether this reader may change the plan, which picks the refusal copy. */
  canManageBilling: boolean;
}>;

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
export function LowBalanceAlertForm({
  organizationId,
  settings,
  canManageBilling,
}: LowBalanceAlertFormProps) {
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
  const [outcome, setOutcome] = useState<SaveOutcome>({ kind: 'idle' });
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
    setOutcome({ kind: 'idle' });
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
      setThresholdDraftError(thresholdError(thresholdRef.current) ?? null);
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
    // A new write supersedes the last confirmation. A rejected write stays: it
    // is the one being retried, and its Retry carries the busy state until this
    // write settles, which then replaces it with one outcome.
    setOutcome(previous => (previous.kind === 'saved' ? { kind: 'idle' } : previous));
    const version = draftVersion.current;
    saveMutation.mutate(input, {
      onSuccess: () => {
        settle(version, () => {
          notificationHaptic(Haptics.NotificationFeedbackType.Success);
          setOutcome({ kind: 'saved' });
        });
      },
      onError: error => {
        settle(version, () => {
          setOutcome({ kind: 'failed', failure: { error, input } });
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

  // The sentence and the step are chosen for this reader's role: only the plan
  // refusal offers a step, and only to a role the server would let take it.
  const failure = outcome.kind === 'failed' ? outcome.failure : null;
  const failureCopy = failure === null ? null : saveErrorCopy(failure.error, canManageBilling);
  const trialRefusalAction = useTrialRefusalAction(
    failure !== null && isTrialExpiredRefusal(failure.error),
    organizationId
  );

  // The error is announced once: under the recipients when the server rejected
  // an address and the field is on screen, otherwise on the form line. The
  // rejected sentence keeps priority over a last confirmation.
  const emailFailure = enabled && failureCopy?.field === 'emails' ? failureCopy : null;
  const saveFailureHere = emailFailure?.message ?? null;
  const saveFailureOnForm =
    failureCopy !== null && emailFailure === null ? failureCopy.message : null;

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
            reserveErrorMessages={thresholdErrorMessages()}
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
              validateWhileTyping
              reserveErrorMessages={emailsErrorMessages()}
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
          rejected an address, otherwise here. The outcome is one value, so the
          rejection and the confirmation never paint together; the Retry
          resends the rejected write so it cannot drift from the values that
          failed. A refusal this reader can end carries the billing step under
          the copy. */}
      {saveFailureOnForm != null && (
        <RefusalStatus
          message={saveFailureOnForm}
          action={trialRefusalAction}
          className="text-sm"
        />
      )}
      {outcome.kind === 'saved' && (
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
