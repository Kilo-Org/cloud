import { USER_DELETION_KILOCODE_APP_EMAIL } from '@/lib/user/deletion-queue/deletion-constants';
import {
  isBlockedDeletionTargetEmail,
  isInternalOrRelayEmail,
  normalizeDeletionEmail,
} from '@/lib/user/deletion-queue/deletion-intake';
import {
  fetchPylonIssueForPreflight,
  fetchPylonIssueMessagesForPreflight,
  type PylonMessageForPreflight,
} from '@/lib/user/deletion-queue/handlers/pylon-client';

export type TicketEmailResolution =
  | { kind: 'resolved'; email: string }
  | { kind: 'attention'; code: string }
  | { kind: 'retryable' };

export async function resolveTicketEmail(ticket: string): Promise<TicketEmailResolution> {
  const issueResult = await fetchPylonIssueForPreflight(ticket);
  if (issueResult.kind !== 'ok') {
    return issueResult.kind === 'retryable'
      ? { kind: 'retryable' }
      : { kind: 'attention', code: issueResult.code };
  }

  const issue = issueResult.value;
  const hasDeleteReady = issue.tags.some(tag => tag.trim().toLowerCase() === 'delete-ready');
  if (!hasDeleteReady) {
    return { kind: 'attention', code: 'delete_ready_missing' };
  }

  const messagesResult = await fetchPylonIssueMessagesForPreflight(issue.id);
  if (messagesResult.kind !== 'ok') {
    return messagesResult.kind === 'retryable'
      ? { kind: 'retryable' }
      : { kind: 'attention', code: messagesResult.code };
  }

  const resolved = customerEmailFromPylonIssue(issue.requesterEmail, messagesResult.value);
  if (resolved.kind !== 'resolved') return resolved;
  if (isBlockedDeletionTargetEmail(resolved.email)) {
    return { kind: 'attention', code: 'relay_or_internal_email' };
  }
  return resolved;
}

export function customerEmailFromPylonIssue(
  requesterEmail: string | null,
  messages: PylonMessageForPreflight[]
): TicketEmailResolution {
  const appRelay = firstMessageAppRelayReplyToEmail(messages);
  if (appRelay.kind !== 'absent') return appRelay;

  const requester = requesterEmail ? normalizeDeletionEmail(requesterEmail) : '';
  const email =
    requester && !isInternalOrRelayEmail(requester)
      ? requester
      : requesterEmailFromMessages(messages);
  if (!email) {
    return { kind: 'attention', code: 'ticket_unresolved' };
  }
  return { kind: 'resolved', email: normalizeDeletionEmail(email) };
}

function firstMessageAppRelayReplyToEmail(
  messages: PylonMessageForPreflight[]
): TicketEmailResolution | { kind: 'absent' } {
  const firstMessage = messages[0];
  const emailInfo = firstMessage?.emailInfo;
  if (!emailInfo) return { kind: 'absent' };

  const fromEmail = emailCandidates(emailInfo.from_email)[0];
  const toEmails = [...new Set(emailCandidates(emailInfo.to_emails))];
  if (
    fromEmail !== USER_DELETION_KILOCODE_APP_EMAIL ||
    toEmails.length !== 1 ||
    toEmails[0] !== USER_DELETION_KILOCODE_APP_EMAIL
  ) {
    return { kind: 'absent' };
  }

  const replyToEmails = replyToEmailsFromMessage(firstMessage);
  if (replyToEmails.length === 1 && replyToEmails[0]) {
    return { kind: 'resolved', email: replyToEmails[0] };
  }
  if (replyToEmails.length > 1) {
    return { kind: 'attention', code: 'app_relay_reply_to_ambiguous' };
  }
  return { kind: 'attention', code: 'app_relay_reply_to_missing' };
}

function replyToEmailsFromMessage(message: PylonMessageForPreflight): string[] {
  const emailInfo = message.emailInfo;
  if (!emailInfo) return [];
  return [
    ...new Set(
      [
        ...emailCandidates(emailInfo.reply_to_email),
        ...emailCandidates(emailInfo.reply_to_emails),
        ...emailCandidates(emailInfo.reply_to),
        ...emailCandidates(emailInfo['reply-to']),
      ].filter(email => !isInternalOrRelayEmail(email))
    ),
  ];
}

function requesterEmailFromMessages(messages: PylonMessageForPreflight[]): string | undefined {
  for (const message of messages) {
    const email = externalEmailFromMessage(message);
    if (email) return email;
  }
  return undefined;
}

function externalEmailFromMessage(message: PylonMessageForPreflight): string | undefined {
  const fromEmail = stringValue(message.emailInfo?.from_email)?.toLowerCase();
  if (fromEmail && isInternalOrRelayEmail(fromEmail)) {
    for (const value of emailList(message.emailInfo?.to_emails)) {
      if (!isInternalOrRelayEmail(value)) return value;
    }
  }

  for (const value of [
    message.authorContactEmail,
    message.emailInfo?.from_email,
    message.authorUserEmail,
  ]) {
    const email = stringValue(value)?.toLowerCase();
    if (email && !isInternalOrRelayEmail(email)) return email;
  }
  return undefined;
}

function emailList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const email = stringValue(entry)?.toLowerCase();
    return email ? [email] : [];
  });
}

function emailCandidates(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(emailCandidates);
  if (typeof value !== 'string') return [];
  return [
    ...value
      .trim()
      .toLowerCase()
      .matchAll(/[^\s<>,;]+@[^\s<>,;]+\.[^\s<>,;]+/g),
  ]
    .map(match => match[0])
    .filter(isEmailInput);
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isEmailInput(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim().toLowerCase());
}
