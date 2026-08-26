import {
  AlertThresholdUsdInputSchema,
  formatAlertThresholdUsdInput,
  MAX_ORGANIZATION_ALERT_RECIPIENTS,
  MONTHLY_SPENDING_ALERT_TYPE,
  OrganizationAlertRecipientSchema,
  OrganizationAlertRecipientsSchema,
  RECIPIENT_DISCLOSURE_REQUIRED_MESSAGE,
  type MonthlySpendingAlertConfiguration,
  type OrganizationAlertDefinitionOf,
} from '@/lib/organizations/alerts/organization-alerts';

/** Everything the Monthly Spending editor holds while it is being filled in. */
export type MonthlySpendingFormState = {
  /** USD text exactly as typed; converted to microdollars only on save. */
  thresholdUsd: string;
  recipients: string[];
  /** An address that has been typed but not added to `recipients` yet. */
  pendingRecipient: string;
  disclosureConfirmed: boolean;
};

export type MonthlySpendingFormErrors = Partial<
  Record<'thresholdUsd' | 'pendingRecipient' | 'recipients' | 'disclosure', string>
>;

export function monthlySpendingFormState(
  configuration: MonthlySpendingAlertConfiguration
): MonthlySpendingFormState {
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
export function addMonthlySpendingRecipient(
  state: MonthlySpendingFormState
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
 * Explains the alert-period admission cap when it has been reached, so a user who
 * adds an address now understands why it cannot receive this alert yet. The count
 * is the router's report of distinct recipients already admitted this period,
 * including addresses that have since been removed.
 */
export function monthlySpendingAdmissionNotice(admittedRecipientCount: number): string | null {
  if (admittedRecipientCount < MAX_ORGANIZATION_ALERT_RECIPIENTS) return null;
  // "Admitted" rather than "notified": a claim is created before its email is
  // sent, and it still holds one of the month's slots if it was canceled.
  return `This alert has already admitted ${MAX_ORGANIZATION_ALERT_RECIPIENTS} addresses to delivery in the current UTC calendar month, which is its limit for one month. An address added now cannot receive this alert until the next month.`;
}

type MonthlySpendingSubmissionParams = {
  state: MonthlySpendingFormState;
  mode: 'create' | 'edit';
  /** The configuration the editor opened with: its period and saved recipients. */
  saved: MonthlySpendingAlertConfiguration;
  /** An enabled alert must be able to notify at least one recipient. */
  requireRecipient: boolean;
};

/**
 * Saving a new alert always configures a disclosure, and so does adding an
 * address to an existing one. Removing addresses does not, so a downgraded
 * organization can still shrink its recipient list.
 */
export function monthlySpendingDisclosureRequired(params: {
  state: MonthlySpendingFormState;
  mode: 'create' | 'edit';
  saved: MonthlySpendingAlertConfiguration;
}): boolean {
  if (params.mode === 'create') return true;
  const savedRecipients = new Set(params.saved.recipients);
  return params.state.recipients.some(recipient => !savedRecipients.has(recipient));
}

export type MonthlySpendingSubmission =
  | {
      ok: true;
      definition: OrganizationAlertDefinitionOf<typeof MONTHLY_SPENDING_ALERT_TYPE>;
      recipientDisclosureConfirmed: boolean;
    }
  | { ok: false; errors: MonthlySpendingFormErrors };

/**
 * Validates the whole editor at once and produces the definition the router
 * accepts. Every rejection is a field error so it can be shown next to the input
 * that caused it; the server re-validates the same contract.
 */
export function buildMonthlySpendingSubmission(
  params: MonthlySpendingSubmissionParams
): MonthlySpendingSubmission {
  const { state } = params;
  const errors: MonthlySpendingFormErrors = {};

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

  if (monthlySpendingDisclosureRequired(params) && !state.disclosureConfirmed) {
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
      type: MONTHLY_SPENDING_ALERT_TYPE,
      configuration: {
        thresholdMicrodollars: threshold.data,
        // The period is carried through unchanged: this editor supports one
        // definition and must never re-declare an alert's window.
        period: params.saved.period,
        recipients: recipients.data,
      },
    },
    recipientDisclosureConfirmed: state.disclosureConfirmed,
  };
}
