import { i18n } from '@/i18n';

/**
 * The key each triage status the report server reports is shown under, shared by
 * the receipt screen and the list of the reader's own reports so one status
 * reads the same on both.
 */
export const TRIAGE_KEYS = {
  received: 'profile.reportReceipt.triageReceived',
  open: 'profile.reportReceipt.triageOpen',
  actioned: 'profile.reportReceipt.triageActioned',
  rejected: 'profile.reportReceipt.triageRejected',
} as const;

export const APPEAL_KEYS = {
  none: 'profile.reportReceipt.appealNone',
  submitted: 'profile.reportReceipt.appealSubmitted',
  accepted: 'profile.reportReceipt.appealAccepted',
  rejected: 'profile.reportReceipt.appealRejected',
} as const;

/**
 * Translates a status the server reports, through the key its dictionary holds.
 * An unrecognised status is shown as the server sent it, so a status added on the
 * server is readable rather than blank.
 */
export function statusLabel(dictionary: Readonly<Record<string, string>>, status: string): string {
  const key = dictionary[status];
  return key === undefined ? status : i18n.t(key);
}
