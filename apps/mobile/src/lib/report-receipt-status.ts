import { i18n } from '@/i18n';

/**
 * The words a receipt uses: the triage status, appeal status, reported item and
 * reason for report the server reports, each under the key it is shown by. The
 * receipt screen and the list of the reader's own reports share it, so one
 * status reads the same on both.
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

/** What the report was filed against, as the server names it. */
export const TARGET_KEYS = {
  message: 'profile.reportReceipt.targetMessage',
  comment: 'profile.reportReceipt.targetComment',
  user: 'profile.reportReceipt.targetUser',
} as const;

/** Why the reader says they reported it, as the server names it. */
export const REASON_KEYS = {
  harmful: 'profile.reportReceipt.reasonHarmful',
  illegal: 'profile.reportReceipt.reasonIllegal',
  harassment: 'profile.reportReceipt.reasonHarassment',
  spam: 'profile.reportReceipt.reasonSpam',
  other: 'profile.reportReceipt.reasonOther',
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
