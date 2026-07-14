import { EMAIL_PATTERN } from '@/lib/utils';

const THRESHOLD_ERROR = 'Enter an amount greater than 0';
const EMAILS_ERROR = 'Enter at least one valid email, separated by commas';

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
  return parseThreshold(value) == null ? THRESHOLD_ERROR : null;
}

export function emailsError(value: string): string | null {
  const emails = parseEmails(value);
  return emails.length === 0 || !emails.every(email => EMAIL_PATTERN.test(email))
    ? EMAILS_ERROR
    : null;
}
