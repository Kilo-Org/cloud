import { and, eq } from 'drizzle-orm';
import { user_deletion_steps } from '@kilocode/db/schema';
import { UserDeletionStepKey, type UserDeletionTaskProgress } from '@kilocode/db/schema-types';
import { getEnvVariable } from '@/lib/dotenvx';
import { db } from '@/lib/drizzle';
import {
  USER_DELETION_DEFAULT_POSTHOG_HOST,
  USER_DELETION_POSTHOG_VERIFY_WINDOW_MS,
} from '@/lib/user/deletion-queue/deletion-constants';
import {
  decryptDeletionResourceIds,
  encryptDeletionResourceIds,
} from '@/lib/user/deletion-queue/deletion-crypto';
import {
  assertCurrentClaim,
  classifyResponse,
  configurationMissing,
  continueIfLowTime,
  deletionFetch,
  isRecord,
  readJsonUnknown,
  requireTargetEmail,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';
import type { DeletionHandlerOutcome } from '@/lib/user/deletion-queue/deletion-types';
import { deletionEmailsEqual } from '@/lib/user/deletion-queue/deletion-intake';

type PosthogPerson = {
  id: string;
  emails: string[];
  distinctIds: string[];
};

function posthogHost(): string {
  const configured = getEnvVariable('POSTHOG_HOST').trim().replace(/\/$/, '');
  return configured || USER_DELETION_DEFAULT_POSTHOG_HOST;
}

function collectEmails(person: Record<string, unknown>): string[] {
  const emails = new Set<string>();
  const properties = isRecord(person.properties) ? person.properties : null;
  const propertyEmail = properties ? properties.email : undefined;
  if (typeof propertyEmail === 'string' && propertyEmail) emails.add(propertyEmail);
  if (typeof person.name === 'string' && person.name.includes('@')) emails.add(person.name);
  const distinctIds = Array.isArray(person.distinct_ids) ? person.distinct_ids : [];
  for (const value of distinctIds) {
    if (typeof value === 'string' && value.includes('@')) emails.add(value);
  }
  return [...emails];
}

function parsePersons(payload: unknown): PosthogPerson[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.results)) return null;
  const persons: PosthogPerson[] = [];
  for (const entry of payload.results) {
    if (!isRecord(entry)) return null;
    const id =
      typeof entry.id === 'string' || typeof entry.id === 'number' ? String(entry.id) : null;
    if (!id) return null;
    const distinctIds = Array.isArray(entry.distinct_ids)
      ? entry.distinct_ids.filter(
          (value): value is string => typeof value === 'string' && value.length > 0
        )
      : [];
    persons.push({
      id,
      emails: collectEmails(entry),
      distinctIds: distinctIds.length > 0 ? distinctIds : [id],
    });
  }
  return persons;
}

function personsAreAmbiguous(persons: PosthogPerson[], targetEmail: string): boolean {
  for (const person of persons) {
    if (person.emails.some(email => !deletionEmailsEqual(email, targetEmail))) return true;
  }
  const ids = new Set(persons.map(person => person.id));
  return ids.size > 1 && persons.some(person => person.emails.length === 0);
}

async function saveProgress(requestId: string, progress: UserDeletionTaskProgress): Promise<void> {
  await db
    .update(user_deletion_steps)
    .set({ progress_json: progress })
    .where(
      and(
        eq(user_deletion_steps.request_id, requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.Posthog)
      )
    );
}

export const handlePosthog: DeletionHandler = async ({ request, step, context }) => {
  const stop = continueIfLowTime(context);
  if (stop) return stop;

  const emailOrOutcome = requireTargetEmail(request);
  if (typeof emailOrOutcome !== 'string') return emailOrOutcome;

  const apiKey = getEnvVariable('POSTHOG_PERSONAL_API_KEY').trim();
  const projectId = getEnvVariable('POSTHOG_ENVIRONMENT_ID').trim();
  if (!apiKey || !projectId) return configurationMissing();

  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const host = posthogHost();
  let progress = step.progress_json;

  if (progress.provider_ref && progress.provider_ref !== 'reserved') {
    const personIds = decryptCheckpoint(progress);
    if (!personIds) {
      return { kind: 'needs_attention', errorCode: 'posthog_checkpoint_invalid' };
    }
    return verifyPersonsGone(context, host, projectId, headers, progress, personIds);
  }

  let personIds: string[] = [];
  if (progress.encrypted_resource_ids) {
    const decrypted = decryptCheckpoint(progress);
    if (!decrypted) {
      return { kind: 'needs_attention', errorCode: 'posthog_checkpoint_invalid' };
    }
    personIds = decrypted;
  }

  const lookup = await deletionFetch(
    context,
    `${host}/api/projects/${encodeURIComponent(projectId)}/persons/?email=${encodeURIComponent(emailOrOutcome)}`,
    { headers }
  );
  if ('outcome' in lookup) return lookup.outcome;
  if (!lookup.response.ok) return classifyResponse(lookup.response);

  const persons = parsePersons(await readJsonUnknown(lookup.response));
  if (!persons) {
    return { kind: 'needs_attention', errorCode: 'posthog_lookup_incomplete' };
  }
  if (persons.length === 0) {
    if (progress.provider_ref !== 'reserved') {
      return { kind: 'not_applicable' };
    }
    if (personIds.length === 0) {
      return { kind: 'needs_attention', errorCode: 'posthog_checkpoint_invalid' };
    }
    return verifyPersonsGone(context, host, projectId, headers, progress, personIds);
  }

  if (personsAreAmbiguous(persons, emailOrOutcome)) {
    return { kind: 'needs_attention', errorCode: 'posthog_ambiguous' };
  }

  personIds = [...new Set(persons.map(person => person.id))];
  const distinctIds = [...new Set(persons.flatMap(person => person.distinctIds))];

  const lostBeforeReserve = await assertCurrentClaim(context);
  if (lostBeforeReserve) return lostBeforeReserve;

  progress = {
    ...progress,
    provider_ref: 'reserved',
    encrypted_resource_ids: encryptDeletionResourceIds(personIds),
    checkpoint_at: progress.checkpoint_at ?? new Date().toISOString(),
  };
  await saveProgress(request.id, progress);

  const submitStop = continueIfLowTime(context);
  if (submitStop) return submitStop;

  const lostBeforeSubmit = await assertCurrentClaim(context);
  if (lostBeforeSubmit) return lostBeforeSubmit;

  const submit = await deletionFetch(
    context,
    `${host}/api/projects/${encodeURIComponent(projectId)}/persons/bulk_delete`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ distinct_ids: distinctIds, delete_events: true }),
    }
  );
  if ('outcome' in submit) return submit.outcome;
  if (!submit.response.ok && submit.response.status !== 404) {
    return classifyResponse(submit.response);
  }

  const accepted = await readJsonUnknown(submit.response);
  const providerRef =
    isRecord(accepted) && typeof accepted.id === 'string'
      ? accepted.id
      : isRecord(accepted) && typeof accepted.request_id === 'string'
        ? accepted.request_id
        : 'submitted';
  const lostBeforeConfirm = await assertCurrentClaim(context);
  if (lostBeforeConfirm) return lostBeforeConfirm;
  progress = { ...progress, provider_ref: providerRef };
  await saveProgress(request.id, progress);

  return verifyPersonsGone(context, host, projectId, headers, progress, personIds);
};

function decryptCheckpoint(progress: UserDeletionTaskProgress): string[] | null {
  if (!progress.encrypted_resource_ids) return null;
  try {
    return decryptDeletionResourceIds(progress.encrypted_resource_ids);
  } catch {
    return null;
  }
}

async function verifyPersonsGone(
  context: Parameters<DeletionHandler>[0]['context'],
  host: string,
  projectId: string,
  headers: Record<string, string>,
  progress: UserDeletionTaskProgress,
  personIds: string[]
): Promise<DeletionHandlerOutcome> {
  if (personIds.length === 0) {
    return { kind: 'needs_attention', errorCode: 'posthog_checkpoint_invalid' };
  }

  for (const personId of personIds) {
    const pollStop = continueIfLowTime(context);
    if (pollStop) return pollStop;

    const poll = await deletionFetch(
      context,
      `${host}/api/projects/${encodeURIComponent(projectId)}/persons/${encodeURIComponent(personId)}`,
      { headers }
    );
    if ('outcome' in poll) return poll.outcome;
    if (poll.response.status === 404) continue;
    if (!poll.response.ok) return classifyResponse(poll.response);

    const intentAt = progress.checkpoint_at
      ? new Date(progress.checkpoint_at).getTime()
      : Date.now();
    if (Date.now() - intentAt >= USER_DELETION_POSTHOG_VERIFY_WINDOW_MS) {
      return { kind: 'needs_attention', errorCode: 'posthog_verify_timeout' };
    }
    return { kind: 'continue', progress };
  }

  return { kind: 'succeeded', progress };
}
