import { z } from 'zod';

import { i18n } from '@/i18n';
import { parseLocalizedNumber } from '@/lib/format';
import { readTrpcErrorField } from '@/lib/trpc-error';

/**
 * The procedure's own address rule (`z.string().email()` in
 * `organization-settings-router.ts`, the same validator as `z.email()`).
 * Mirroring it here means the field can never accept an entry the server
 * rejects, so a malformed address is reported where it was typed instead of
 * after a round trip.
 */
const EMAIL_SCHEMA = z.email();

export function parseThreshold(value: string): number | null {
  const trimmed = value.trim();
  const parsed = parseLocalizedNumber(trimmed, i18n.language);
  if (trimmed === '' || parsed === null || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function parseEmails(value: string): string[] {
  return value
    .split(',')
    .map(email => email.trim())
    .filter(email => email !== '');
}

export function thresholdError(value: string): string | null {
  return parseThreshold(value) == null
    ? i18n.t('organization.lowBalanceAlert.thresholdError')
    : null;
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
 * field. Every other failure — transport, server error — gets the form-level
 * line next to Save. The raw server message never reaches the UI: a schema
 * rejection carries a JSON array of zod issues, not a sentence.
 */
export function saveErrorCopy(error: unknown): SaveErrorCopy {
  return readTrpcErrorField(error, 'code') === 'BAD_REQUEST'
    ? { field: 'emails', message: i18n.t('organization.lowBalanceAlert.saveEmailsError') }
    : { field: 'form', message: i18n.t('organization.lowBalanceAlert.saveError') };
}
