import { z } from 'zod';

import {
  aboveMaximumError,
  readAmountAtMost,
} from '@/components/organization/amount-field-validators';
import { i18n } from '@/i18n';
import { knownServerErrorMessage } from '@/lib/server-error-copy';
import { readTrpcErrorField } from '@/lib/trpc-error';

/**
 * A distance from zero the form reports as too large instead of handing the
 * server an amount a double can no longer hold between the field and the wire.
 */
const MAX_THRESHOLD_USD = 1_000_000_000;

/** Parse a USD balance: out-of-range values are `null`, never clamped. */
export function parseThreshold(value: string): number | null {
  return readAmountAtMost(value, MAX_THRESHOLD_USD).amount;
}

/**
 * The procedure's own address rule (`z.string().email()` in
 * `organization-settings-router.ts`, the same validator as `z.email()`).
 * Mirroring it here means the field can never accept an entry the server
 * rejects, so a malformed address is reported where it was typed instead of
 * after a round trip.
 */
const EMAIL_SCHEMA = z.email();

export function parseEmails(value: string): string[] {
  return value
    .split(',')
    .map(email => email.trim())
    .filter(email => email !== '');
}

/** Inline error for the balance field, or `null` while the value is valid. */
export function thresholdError(value: string): string | null {
  const { problem } = readAmountAtMost(value, MAX_THRESHOLD_USD);
  if (problem === null) {
    return null;
  }
  if (problem === 'aboveMaximum') {
    return aboveMaximumError(MAX_THRESHOLD_USD);
  }
  return i18n.t('organization.lowBalanceAlert.thresholdError');
}

/**
 * Inline error for the recipient field, or `null` while the value is valid.
 * An empty list and a malformed entry are different mistakes, so they get
 * different sentences; the comma hint below the field already explains how to
 * separate addresses, so neither repeats it.
 */
export function emailsError(value: string): string | null {
  const emails = parseEmails(value);
  if (emails.length === 0) {
    return i18n.t('organization.lowBalanceAlert.emailsRequired');
  }
  return emails.some(email => !EMAIL_SCHEMA.safeParse(email).success)
    ? i18n.t('organization.lowBalanceAlert.emailsInvalid')
    : null;
}

/** Where a failed save belongs and what it says, both localized. */
export type SaveErrorCopy = Readonly<{
  field: 'emails' | 'form';
  message: string;
}>;

/**
 * A save rejected by the input schema is a recipient problem (the form
 * validators already cover the threshold), so it belongs on the recipient
 * field. A rejection the app can explain — a lapsed organization plan — names
 * itself on the form line. Every other failure, transport or server error,
 * gets the form-level line next to Save. The raw server message never reaches
 * the UI: a schema rejection carries a JSON array of zod issues, not a
 * sentence.
 */
export function saveErrorCopy(error: unknown): SaveErrorCopy {
  if (readTrpcErrorField(error, 'code') === 'BAD_REQUEST') {
    return { field: 'emails', message: i18n.t('organization.lowBalanceAlert.saveEmailsError') };
  }
  return {
    field: 'form',
    message: knownServerErrorMessage(error) ?? i18n.t('organization.lowBalanceAlert.saveError'),
  };
}
