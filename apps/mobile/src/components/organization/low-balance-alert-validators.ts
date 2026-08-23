import { i18n } from '@/i18n';
import { EMAIL_PATTERN } from '@/lib/utils';

export function parseThreshold(value: string): number | null {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(parsed) || parsed <= 0) {
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
  return parseThreshold(value) == null ? i18n.t('organization.lowBalanceAlert.thresholdError') : null;
}

export function emailsError(value: string): string | null {
  const emails = parseEmails(value);
  return emails.length === 0 || !emails.every(email => EMAIL_PATTERN.test(email))
    ? i18n.t('organization.lowBalanceAlert.emailsError')
    : null;
}
