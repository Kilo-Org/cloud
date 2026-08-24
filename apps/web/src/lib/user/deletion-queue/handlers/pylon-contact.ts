import { eq, or, sql } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import { isSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';
import { db } from '@/lib/drizzle';
import { USER_DELETION_RESOURCE_BATCH_SIZE } from '@/lib/user/deletion-queue/deletion-constants';
import { writeDeletionActivity } from '@/lib/user/deletion-queue/deletion-audit';
import { hmacDeletionEmail } from '@/lib/user/deletion-queue/deletion-hmac';
import {
  deletionEmailsEqual,
  normalizeDeletionEmail,
} from '@/lib/user/deletion-queue/deletion-intake';
import {
  asNonEmptyString,
  classifyResponse,
  continueIfLowTime,
  incrementProcessed,
  isRecord,
  requireTargetEmail,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';
import {
  pylonConfig,
  pylonData,
  pylonJson,
  pylonRequest,
} from '@/lib/user/deletion-queue/handlers/pylon-client';

type PylonContact = {
  id: string;
  emails: string[];
};

function collectContactEmails(contact: Record<string, unknown>): string[] {
  const emails = new Set<string>();
  const primary = asNonEmptyString(contact.email);
  if (primary) emails.add(primary);
  if (Array.isArray(contact.emails)) {
    for (const value of contact.emails) {
      if (typeof value === 'string' && value) emails.add(value);
      if (isRecord(value)) {
        const nested = asNonEmptyString(value.email) ?? asNonEmptyString(value.address);
        if (nested) emails.add(nested);
      }
    }
  }
  return [...emails];
}

function parseContacts(
  payload: unknown
): { contacts: PylonContact[]; cursor: string | null } | null {
  const data = pylonData(payload);
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.contacts)
      ? data.contacts
      : null;
  if (!list) return null;

  const contacts: PylonContact[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) return null;
    const id = asNonEmptyString(entry.id);
    if (!id) return null;
    contacts.push({ id, emails: collectContactEmails(entry) });
  }

  const pagination = isRecord(payload) && isRecord(payload.pagination) ? payload.pagination : null;
  const cursor =
    (pagination ? asNonEmptyString(pagination.cursor) : null) ??
    (isRecord(payload) ? asNonEmptyString(payload.cursor) : null);
  const hasNext =
    pagination && typeof pagination.has_next_page === 'boolean'
      ? pagination.has_next_page
      : Boolean(cursor);
  return { contacts, cursor: hasNext ? cursor : null };
}

async function kiloUsersForEmails(emails: string[]): Promise<Array<{ id: string; email: string }>> {
  const normalized = [...new Set(emails.map(normalizeDeletionEmail))];
  if (normalized.length === 0) return [];
  const match = or(
    ...normalized.map(email => eq(sql`lower(${kilocode_users.google_user_email})`, email))
  );
  if (!match) return [];
  const users = await db
    .select({
      id: kilocode_users.id,
      google_user_email: kilocode_users.google_user_email,
      blocked_reason: kilocode_users.blocked_reason,
    })
    .from(kilocode_users)
    .where(match);
  return users
    .filter(user => !isSoftDeletedBlockedReason(user.blocked_reason))
    .map(user => ({ id: user.id, email: normalizeDeletionEmail(user.google_user_email) }));
}

export const handlePylonContact: DeletionHandler = async ({ request, step, context }) => {
  const stop = continueIfLowTime(context, step.progress_json);
  if (stop) return stop;

  const emailOrOutcome = requireTargetEmail(request);
  if (typeof emailOrOutcome !== 'string') return emailOrOutcome;

  const config = pylonConfig();
  if (!('apiKey' in config)) return config;

  const cursor = step.progress_json.cursor;
  const searchBody: Record<string, unknown> = {
    filter: { field: 'email', operator: 'equals', value: emailOrOutcome },
    limit: USER_DELETION_RESOURCE_BATCH_SIZE,
  };
  if (cursor) searchBody.cursor = cursor;

  const search = await pylonRequest(context, config.apiKey, '/contacts/search', {
    method: 'POST',
    body: JSON.stringify(searchBody),
  });
  if ('outcome' in search) return search.outcome;
  const searchJson = await pylonJson(search.response);
  if ('outcome' in searchJson) return searchJson.outcome;

  const parsed = parseContacts(searchJson.payload);
  if (!parsed) {
    return { kind: 'needs_attention', errorCode: 'pylon_contact_lookup_incomplete' };
  }

  const startedEmpty =
    (step.progress_json.processed_count ?? 0) === 0 && !cursor && parsed.contacts.length === 0;
  if (parsed.contacts.length === 0 && !parsed.cursor) {
    return startedEmpty
      ? { kind: 'not_applicable' }
      : {
          kind: 'succeeded',
          progress: { processed_count: step.progress_json.processed_count, clean_pass: true },
        };
  }

  for (const contact of parsed.contacts) {
    const extras = contact.emails.filter(email => !deletionEmailsEqual(email, emailOrOutcome));
    const kiloUsers = await kiloUsersForEmails(extras);
    if (kiloUsers.some(user => user.id !== request.user_id)) {
      return { kind: 'needs_attention', errorCode: 'pylon_contact_shared_identity' };
    }
    const known = new Set(kiloUsers.map(user => user.email));
    for (const extra of extras) {
      if (known.has(normalizeDeletionEmail(extra))) continue;
      await db.transaction(async tx => {
        await writeDeletionActivity(tx, {
          requestId: request.id,
          stepKey: context.stepKey,
          eventType: 'pylon_contact_extra_email',
          details: { resource_hmac: hmacDeletionEmail(normalizeDeletionEmail(extra)) },
        });
      });
    }
  }

  let progress = step.progress_json;
  let deleted = 0;
  for (const contact of parsed.contacts.slice(0, USER_DELETION_RESOURCE_BATCH_SIZE)) {
    const reserve = continueIfLowTime(context, progress);
    if (reserve) return reserve;

    const remove = await pylonRequest(
      context,
      config.apiKey,
      `/contacts/${encodeURIComponent(contact.id)}`,
      { method: 'DELETE' }
    );
    if ('outcome' in remove) return remove.outcome;
    if (!remove.response.ok && remove.response.status !== 404) {
      return classifyResponse(remove.response);
    }

    deleted += 1;
    progress = incrementProcessed(progress);
  }

  if (deleted > 0) {
    return {
      kind: 'continue',
      progress: { processed_count: progress.processed_count, clean_pass: false },
    };
  }
  if (parsed.cursor) {
    return { kind: 'continue', progress: { ...progress, cursor: parsed.cursor } };
  }
  return {
    kind: 'succeeded',
    progress: { processed_count: progress.processed_count, clean_pass: true },
  };
};
