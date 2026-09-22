import {
  AlertThresholdUsdInputSchema,
  formatAlertThresholdUsdInput,
  LOW_BALANCE_ALERT_TYPE,
  MAX_ORGANIZATION_ALERT_RECIPIENTS,
  OrganizationAlertRecipientSchema,
  OrganizationAlertRecipientsSchema,
  RECIPIENT_DISCLOSURE_REQUIRED_MESSAGE,
  type LowBalanceAlertConfiguration,
  type OrganizationAlertDefinitionOf,
} from '@/lib/organizations/alerts/organization-alerts';

/** Everything the Low Balance editor holds while it is being filled in. */
export type LowBalanceFormState = {
  /** USD text exactly as typed; converted to microdollars only on save. */
  thresholdUsd: string;
  recipients: string[];
  /** An address that has been typed but not added to `recipients` yet. */
  pendingRecipient: string;
  disclosureConfirmed: boolean;
};

export type LowBalanceFormErrors = Partial<
  Record<'thresholdUsd' | 'pendingRecipient' | 'recipients' | 'disclosure', string>
>;

export function lowBalanceFormState(
  configuration: LowBalanceAlertConfiguration
): LowBalanceFormState {
  return {
    // Zero is not a savable threshold, which is how a new alert starts, so the
    // field opens empty instead of suggesting $0.00.
    thresholdUsd:
      configuration.thresholdMicrodollars > 0
        ? formatAlertThresholdUsdInput(configuration.thresholdMicrodollars)
        : '',
    recipients: [...configuration.recipients],
    pendingRecipient: '',
    disclosureConfirmed: false,
  };
}

/**
 * Normalizes and appends the pending address. Recipients are normalized here so
 * the list the user sees is the identity the alert will actually deliver to and
 * duplicates cannot silently consume one of the ten slots.
 */
export function addLowBalanceRecipient(
  state: LowBalanceFormState
): { ok: true; recipients: string[] } | { ok: false; error: string } {
  const parsed = OrganizationAlertRecipientSchema.safeParse(state.pendingRecipient);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Enter a valid email address' };
  }
  if (state.recipients.includes(parsed.data)) {
    return { ok: false, error: 'This address is already a recipient.' };
  }
  if (state.recipients.length >= MAX_ORGANIZATION_ALERT_RECIPIENTS) {
    return {
      ok: false,
      error: `An alert may notify at most ${MAX_ORGANIZATION_ALERT_RECIPIENTS} addresses. Remove one first.`,
    };
  }
  return { ok: true, recipients: [...state.recipients, parsed.data] };
}

/**
 * Explains the crossing-admission cap when it has been reached. Unlike Monthly
 * Spending, this has no calendar reset: the cap applies to the alert's current
 * crossing (from the balance dropping below the threshold until it recovers
 * back to or above it), and clears the next time the alert crosses again.
 */
export function lowBalanceAdmissionNotice(admittedRecipientCount: number): string | null {
  if (admittedRecipientCount < MAX_ORGANIZATION_ALERT_RECIPIENTS) return null;
  // "Admitted" rather than "notified": a claim is created before its email is
  // sent, and it still holds one of the crossing's slots if it was canceled.
  return `This alert has already admitted ${MAX_ORGANIZATION_ALERT_RECIPIENTS} addresses to delivery for its current low-balance crossing, which is its limit until the balance recovers and drops below the threshold again. An address added now cannot receive this alert until then.`;
}

type LowBalanceSubmissionParams = {
  state: LowBalanceFormState;
  mode: 'create' | 'edit';
  /** An enabled alert must be able to notify at least one recipient. */
  requireRecipient: boolean;
};

/**
 * Saving a new alert always configures a disclosure, and so does adding an
 * address to an existing one. Removing addresses does not, so a downgraded
 * organization can still shrink its recipient list.
 */
export function lowBalanceDisclosureRequired(params: {
  state: LowBalanceFormState;
  mode: 'create' | 'edit';
  saved: LowBalanceAlertConfiguration;
}): boolean {
  if (params.mode === 'create') return true;
  const savedRecipients = new Set(params.saved.recipients);
  return params.state.recipients.some(recipient => !savedRecipients.has(recipient));
}

export type LowBalanceSubmission =
  | {
      ok: true;
      definition: OrganizationAlertDefinitionOf<typeof LOW_BALANCE_ALERT_TYPE>;
      recipientDisclosureConfirmed: boolean;
    }
  | { ok: false; errors: LowBalanceFormErrors };

/**
 * Validates the whole editor at once and produces the definition the router
 * accepts. Every rejection is a field error so it can be shown next to the input
 * that caused it; the server re-validates the same contract.
 */
export function buildLowBalanceSubmission(
  params: LowBalanceSubmissionParams & { saved: LowBalanceAlertConfiguration }
): LowBalanceSubmission {
  const { state } = params;
  const errors: LowBalanceFormErrors = {};

  const threshold = AlertThresholdUsdInputSchema.safeParse(state.thresholdUsd);
  if (!threshold.success) {
    errors.thresholdUsd = threshold.error.issues[0]?.message ?? 'Enter a valid amount';
  }

  if (state.pendingRecipient.trim()) {
    errors.pendingRecipient = 'Add this address or clear the field before saving.';
  }

  const recipients = OrganizationAlertRecipientsSchema.safeParse(state.recipients);
  if (!recipients.success) {
    errors.recipients = recipients.error.issues[0]?.message ?? 'Check the recipient addresses';
  } else if (params.requireRecipient && recipients.data.length === 0) {
    errors.recipients = 'Add at least one recipient email address';
  }

  if (lowBalanceDisclosureRequired(params) && !state.disclosureConfirmed) {
    errors.disclosure = RECIPIENT_DISCLOSURE_REQUIRED_MESSAGE;
  }

  // The two `success` checks are what narrow the parsed values below; any field
  // error at all still stops the save.
  if (Object.keys(errors).length > 0 || !threshold.success || !recipients.success) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    definition: {
      type: LOW_BALANCE_ALERT_TYPE,
      configuration: {
        thresholdMicrodollars: threshold.data,
        recipients: recipients.data,
      },
    },
    recipientDisclosureConfirmed: state.disclosureConfirmed,
  };
}
