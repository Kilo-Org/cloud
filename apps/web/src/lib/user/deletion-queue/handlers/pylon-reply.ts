import { and, eq } from 'drizzle-orm';
import { user_deletion_steps } from '@kilocode/db/schema';
import {
  UserDeletionPylonReplyState,
  UserDeletionStepStatus,
  type UserDeletionTaskProgress,
} from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import { getEnvVariable } from '@/lib/dotenvx';
import { USER_DELETION_PYLON_REPLY_TEXT } from '@/lib/user/deletion-queue/deletion-constants';
import {
  deletionEmailsEqual,
  normalizeDeletionEmail,
} from '@/lib/user/deletion-queue/deletion-intake';
import type {
  DeletionHandlerContext,
  DeletionHandlerOutcome,
} from '@/lib/user/deletion-queue/deletion-types';
import {
  asNonEmptyString,
  classifyResponse,
  continueIfLowTime,
  isRecord,
  requireTargetEmail,
  resourceHmac,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';
import {
  normalizePylonTicket,
  pylonConfig,
  pylonData,
  pylonJson,
  pylonRequest,
} from '@/lib/user/deletion-queue/handlers/pylon-client';

type PylonIssue = {
  id: string;
  requesterEmail: string | null;
  source: string | null;
  state: string | null;
};

type PylonMessage = {
  id: string;
  isPrivate: boolean;
  html: string | null;
  timestamp: string | null;
  threadId: string | null;
  authorUserId: string | null;
  toEmails: string[];
  ccEmails: string[];
  bccEmails: string[];
  contactEmail: string | null;
  fromEmail: string | null;
};

function parseIssue(payload: unknown): PylonIssue | null {
  const data = pylonData(payload);
  if (!isRecord(data)) return null;
  const id = asNonEmptyString(data.id);
  if (!id) return null;
  const requester = isRecord(data.requester) ? data.requester : null;
  return {
    id,
    requesterEmail: requester ? asNonEmptyString(requester.email) : null,
    source: asNonEmptyString(data.source),
    state: asNonEmptyString(data.state),
  };
}

function emailList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const emails: string[] = [];
  for (const entry of value) {
    const email = asNonEmptyString(entry);
    if (email) emails.push(email);
  }
  return emails;
}

function parseMessage(entry: unknown): PylonMessage | null {
  if (!isRecord(entry)) return null;
  const id = asNonEmptyString(entry.id);
  if (!id) return null;
  const author = isRecord(entry.author) ? entry.author : null;
  const authorUser = author && isRecord(author.user) ? author.user : null;
  const authorContact = author && isRecord(author.contact) ? author.contact : null;
  const emailInfo = isRecord(entry.email_info) ? entry.email_info : null;
  return {
    id,
    isPrivate: entry.is_private === true,
    html: typeof entry.message_html === 'string' ? entry.message_html : null,
    timestamp: asNonEmptyString(entry.timestamp),
    threadId: asNonEmptyString(entry.thread_id),
    authorUserId: authorUser ? asNonEmptyString(authorUser.id) : null,
    toEmails: emailInfo ? emailList(emailInfo.to_emails) : [],
    ccEmails: emailInfo ? emailList(emailInfo.cc_emails) : [],
    bccEmails: emailInfo ? emailList(emailInfo.bcc_emails) : [],
    contactEmail: authorContact ? asNonEmptyString(authorContact.email) : null,
    fromEmail: emailInfo ? asNonEmptyString(emailInfo.from_email) : null,
  };
}

function parseMessagesPage(
  payload: unknown
): { messages: PylonMessage[]; nextCursor: string | undefined } | null {
  const data = pylonData(payload);
  if (!Array.isArray(data)) return null;
  const messages: PylonMessage[] = [];
  for (const entry of data) {
    const message = parseMessage(entry);
    if (!message) return null;
    messages.push(message);
  }
  const pagination = isRecord(payload) && isRecord(payload.pagination) ? payload.pagination : null;
  const nextCursor =
    pagination?.has_next_page === true
      ? (asNonEmptyString(pagination.cursor) ?? undefined)
      : undefined;
  return { messages, nextCursor };
}

function normalizeMessageHtml(html: string): string {
  return html.replace(/\s+/g, '').toLowerCase();
}

function expectedReplyHtml(): string {
  return normalizeMessageHtml(`<p>${USER_DELETION_PYLON_REPLY_TEXT}</p>`);
}

function messageThreadKey(message: PylonMessage): string | undefined {
  return message.threadId ?? message.id;
}

function messageAddressedToEmail(message: PylonMessage, email: string): boolean {
  return [...message.toEmails, ...message.ccEmails, ...message.bccEmails].some(candidate =>
    deletionEmailsEqual(candidate, email)
  );
}

function customerThreadKeysForEmail(messages: PylonMessage[], email: string): Set<string> {
  const target = normalizeDeletionEmail(email);
  return new Set(
    messages
      .filter(message => {
        if (message.isPrivate) return false;
        const contact = message.contactEmail ? normalizeDeletionEmail(message.contactEmail) : null;
        const from = message.fromEmail ? normalizeDeletionEmail(message.fromEmail) : null;
        return contact === target || from === target || messageAddressedToEmail(message, email);
      })
      .map(messageThreadKey)
      .filter((threadKey): threadKey is string => Boolean(threadKey))
  );
}

function findMatchingDeletionReply(
  messages: PylonMessage[],
  email: string,
  notBefore: Date
): PylonMessage | undefined {
  const expectedHtml = expectedReplyHtml();
  const expectedAuthorUserId = getEnvVariable('PYLON_FINAL_EMAIL_AUTHOR_USER_ID').trim();
  const customerThreadKeys = customerThreadKeysForEmail(messages, email);
  return messages.find(message => {
    if (message.isPrivate) return false;
    if (expectedAuthorUserId) {
      if (!message.authorUserId || message.authorUserId !== expectedAuthorUserId) return false;
    }
    if (!message.html || !normalizeMessageHtml(message.html).includes(expectedHtml)) return false;
    if (!message.timestamp) return false;
    const timestamp = Date.parse(message.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < notBefore.getTime()) return false;
    if (messageAddressedToEmail(message, email)) return true;
    const threadKey = messageThreadKey(message);
    return Boolean(threadKey && customerThreadKeys.has(threadKey));
  });
}

function replyDefinitelyRejected(status: number): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 422 ||
    status === 429
  );
}

function postedProgress(
  progress: UserDeletionTaskProgress,
  replyMessageId: string
): UserDeletionTaskProgress {
  return {
    ...progress,
    reply_state: UserDeletionPylonReplyState.Posted,
    reply_message_id: replyMessageId,
  };
}

function clearPostingProgress(progress: UserDeletionTaskProgress): UserDeletionTaskProgress {
  const next = { ...progress };
  delete next.reply_state;
  return next;
}

async function saveProgress(
  context: DeletionHandlerContext,
  progress: UserDeletionTaskProgress
): Promise<DeletionHandlerOutcome | null> {
  const [updated] = await db
    .update(user_deletion_steps)
    .set({ progress_json: progress })
    .where(
      and(
        eq(user_deletion_steps.request_id, context.requestId),
        eq(user_deletion_steps.step_key, context.stepKey),
        eq(user_deletion_steps.claim_token, context.claimToken),
        eq(user_deletion_steps.status, UserDeletionStepStatus.Running)
      )
    )
    .returning({ id: user_deletion_steps.id });
  if (updated) return null;
  return { kind: 'retry', errorCode: 'claim_lost', httpStatusClass: 'error' };
}

async function fetchAllMessages(
  context: DeletionHandlerContext,
  apiKey: string,
  issueId: string
): Promise<{ messages: PylonMessage[] } | { outcome: DeletionHandlerOutcome }> {
  const messages: PylonMessage[] = [];
  let cursor: string | undefined;
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const result = await pylonRequest(
      context,
      apiKey,
      `/issues/${encodeURIComponent(issueId)}/messages${query}`
    );
    if ('outcome' in result) return result;
    const json = await pylonJson(result.response);
    if ('outcome' in json) return json;
    const page = parseMessagesPage(json.payload);
    if (!page) {
      return { outcome: { kind: 'needs_attention', errorCode: 'pylon_messages_unparsed' } };
    }
    messages.push(...page.messages);
    cursor = page.nextCursor;
  } while (cursor);
  return { messages };
}

function requestNotBefore(createdAt: string): Date {
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

export const handlePylonReply: DeletionHandler = async ({ request, step, context }) => {
  if (!request.pylon_ticket_ref) {
    return { kind: 'not_applicable' };
  }

  const stop = continueIfLowTime(context);
  if (stop) return stop;

  const emailOrOutcome = requireTargetEmail(request);
  if (typeof emailOrOutcome !== 'string') return emailOrOutcome;

  const config = pylonConfig();
  if (!('apiKey' in config)) return config;

  const issueId = normalizePylonTicket(request.pylon_ticket_ref);
  if (!issueId) {
    return { kind: 'needs_attention', errorCode: 'pylon_ticket_invalid' };
  }

  const issueResult = await pylonRequest(
    context,
    config.apiKey,
    `/issues/${encodeURIComponent(issueId)}`
  );
  if ('outcome' in issueResult) return issueResult.outcome;
  const issueJson = await pylonJson(issueResult.response);
  if ('outcome' in issueJson) return issueJson.outcome;
  const issue = parseIssue(issueJson.payload);
  if (!issue) {
    return { kind: 'needs_attention', errorCode: 'pylon_issue_unparsed' };
  }
  if (!issue.requesterEmail) {
    return { kind: 'needs_attention', errorCode: 'pylon_issue_requester_missing' };
  }
  if (!deletionEmailsEqual(issue.requesterEmail, emailOrOutcome)) {
    return {
      kind: 'needs_attention',
      errorCode: 'pylon_issue_identity_mismatch',
      resourceHmac: resourceHmac(issue.id),
    };
  }

  let progress = step.progress_json;
  const notBefore = requestNotBefore(request.created_at);
  const mustReconcile =
    progress.reply_state === UserDeletionPylonReplyState.Posting ||
    progress.reply_state === UserDeletionPylonReplyState.Ambiguous;

  if (progress.reply_state !== UserDeletionPylonReplyState.Posted || !progress.reply_message_id) {
    const listed = await fetchAllMessages(context, config.apiKey, issue.id);
    if ('outcome' in listed) return listed.outcome;
    const existing = findMatchingDeletionReply(listed.messages, emailOrOutcome, notBefore);
    if (existing) {
      progress = postedProgress(progress, existing.id);
      const lost = await saveProgress(context, progress);
      if (lost) return lost;
    } else if (mustReconcile) {
      return { kind: 'needs_attention', errorCode: 'pylon_reply_inconclusive' };
    } else {
      const thread = listed.messages.find(message => !message.isPrivate);
      if (!thread) {
        return { kind: 'needs_attention', errorCode: 'pylon_reply_thread_missing' };
      }

      const reserve = continueIfLowTime(context);
      if (reserve) return reserve;

      progress = { ...progress, reply_state: UserDeletionPylonReplyState.Posting };
      const lostBeforePost = await saveProgress(context, progress);
      if (lostBeforePost) return lostBeforePost;

      const body: Record<string, unknown> = {
        body_html: `<p>${USER_DELETION_PYLON_REPLY_TEXT}</p>`,
        message_id: thread.threadId ?? thread.id,
      };
      if (issue.source === 'email') {
        body.email_info = { to_emails: [emailOrOutcome] };
      }

      const post = await pylonRequest(
        context,
        config.apiKey,
        `/issues/${encodeURIComponent(issue.id)}/reply`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      );
      if ('outcome' in post) {
        progress = { ...progress, reply_state: UserDeletionPylonReplyState.Ambiguous };
        const lost = await saveProgress(context, progress);
        if (lost) return lost;
        return post.outcome;
      }

      if (post.response.ok) {
        const posted = await post.response.json().catch(() => undefined);
        const postedData = isRecord(posted) ? pylonData(posted) : null;
        const replyMessageId = isRecord(postedData) ? asNonEmptyString(postedData.id) : null;
        if (!replyMessageId) {
          progress = { ...progress, reply_state: UserDeletionPylonReplyState.Ambiguous };
          const lost = await saveProgress(context, progress);
          if (lost) return lost;
          return { kind: 'needs_attention', errorCode: 'pylon_reply_inconclusive' };
        }
        progress = postedProgress(progress, replyMessageId);
        const lost = await saveProgress(context, progress);
        if (lost) return lost;
      } else if (replyDefinitelyRejected(post.response.status)) {
        progress = clearPostingProgress(progress);
        const lost = await saveProgress(context, progress);
        if (lost) return lost;
        return classifyResponse(post.response);
      } else {
        progress = { ...progress, reply_state: UserDeletionPylonReplyState.Ambiguous };
        const lost = await saveProgress(context, progress);
        if (lost) return lost;
        return classifyResponse(post.response);
      }
    }
  }

  if (!progress.close_confirmed && issue.state !== 'closed') {
    const reserve = continueIfLowTime(context, progress);
    if (reserve) return reserve;

    const close = await pylonRequest(
      context,
      config.apiKey,
      `/issues/${encodeURIComponent(issue.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      }
    );
    if ('outcome' in close) return close.outcome;
    if (!close.response.ok && close.response.status !== 404) {
      return classifyResponse(close.response);
    }
  }

  return {
    kind: 'succeeded',
    progress: { ...progress, close_confirmed: true },
  };
};
