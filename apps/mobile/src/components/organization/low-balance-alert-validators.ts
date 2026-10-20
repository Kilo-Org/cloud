import { i18n } from '@/i18n';
import { formatNumber, parseLocalizedNumber } from '@/lib/format';
import { EMAIL_PATTERN } from '@/lib/utils';

/**
 * Zero is the exclusive lower bound the error copy names ("greater than
 * {{min}}"); `parseThreshold` rejects it and every value below the smallest
 * representable amount.
 */
const EXCLUSIVE_MIN_THRESHOLD_USD = 0;

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
    ? i18n.t('organization.lowBalanceAlert.thresholdError', {
        min: formatNumber(EXCLUSIVE_MIN_THRESHOLD_USD, i18n.language),
      })
    : null;
}

export function emailsError(value: string): string | null {
  const emails = parseEmails(value);
  return emails.length === 0 || !emails.every(email => EMAIL_PATTERN.test(email))
    ? i18n.t('organization.lowBalanceAlert.emailsError')
    : null;
}
