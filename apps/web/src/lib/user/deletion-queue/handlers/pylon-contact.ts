import { USER_DELETION_RESOURCE_BATCH_SIZE } from '@/lib/user/deletion-queue/deletion-constants';
import { deletionEmailsEqual } from '@/lib/user/deletion-queue/deletion-intake';
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

function contactIsAmbiguous(contact: PylonContact, targetEmail: string): boolean {
  if (contact.emails.length === 0) return true;
  return contact.emails.some(email => !deletionEmailsEqual(email, targetEmail));
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
    if (contactIsAmbiguous(contact, emailOrOutcome)) {
      return { kind: 'needs_attention', errorCode: 'pylon_contact_ambiguous' };
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
