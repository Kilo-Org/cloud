import type { OrganizationSettings } from '@/lib/organizations/organization-types';

/**
 * Recipients that would actually receive the legacy low-balance alert. It is
 * only on when a threshold and at least one address are both configured, which
 * is the same condition `SpendingAlertsModal` treats as enabled.
 */
export function lowBalanceAlertRecipientCount(settings: OrganizationSettings | undefined): number {
  if (settings?.minimum_balance === undefined) return 0;
  return settings.minimum_balance_alert_email?.length ?? 0;
}

/** One vocabulary for the low-balance state wherever it is summarized. */
export function lowBalanceAlertStateLabel(recipientCount: number): string {
  if (recipientCount === 0) return 'Off';
  return `On · ${recipientCount} recipient${recipientCount === 1 ? '' : 's'}`;
}

export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

export function resolveNotificationEmails(emails: string[], pendingEmail: string): string[] | null {
  const trimmedEmail = pendingEmail.trim();

  if (!trimmedEmail) return emails;
  if (!isValidEmail(trimmedEmail)) return null;
  if (emails.includes(trimmedEmail)) return emails;

  return [...emails, trimmedEmail];
}
