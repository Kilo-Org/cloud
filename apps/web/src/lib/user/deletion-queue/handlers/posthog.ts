import { and, eq, sql } from 'drizzle-orm';
import { kilocode_users, user_deletion_steps } from '@kilocode/db/schema';
import { UserDeletionStepKey, type UserDeletionTaskProgress } from '@kilocode/db/schema-types';
import { isSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';
import { getEnvVariable } from '@/lib/dotenvx';
import { db } from '@/lib/drizzle';
import { writeDeletionActivity } from '@/lib/user/deletion-queue/deletion-audit';
import {
  USER_DELETION_DEFAULT_POSTHOG_HOST,
  USER_DELETION_POSTHOG_MAX_VERIFY_ATTEMPTS,
} from '@/lib/user/deletion-queue/deletion-constants';
import {
  decryptDeletionResourceIds,
  encryptDeletionResourceIds,
} from '@/lib/user/deletion-queue/deletion-crypto';
import { hmacResourceRef } from '@/lib/user/deletion-queue/deletion-hmac';
import {
  deletionEmailsEqual,
  normalizeDeletionEmail,
} from '@/lib/user/deletion-queue/deletion-intake';
import {
  assertCurrentClaim,
  classifyResponse,
  continueIfLowTime,
  deletionFetch,
  isRecord,
  readJsonUnknown,
  requireTargetEmail,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';
import type {
  DeletionHandlerContext,
  DeletionHandlerOutcome,
} from '@/lib/user/deletion-queue/deletion-types';

type PosthogPerson = {
  uuid: string;
  emails: string[];
};

type ParsePersonsResult =
  | { kind: 'ok'; persons: PosthogPerson[] }
  | { kind: 'incomplete' }
  | { kind: 'missing_uuid' };

function posthogHost(): string {
  const configured = getEnvVariable('POSTHOG_HOST').trim().replace(/\/$/, '');
  return configured || USER_DELETION_DEFAULT_POSTHOG_HOST;
}

export function getPostHogPersonsSearchUrl(email: string): string {
  const host = posthogHost();
  const projectId = getEnvVariable('POSTHOG_ENVIRONMENT_ID').trim();
  const path = projectId ? `/project/${encodeURIComponent(projectId)}/persons` : '/persons';
  return `${host}${path}?search=${encodeURIComponent(email.trim().toLowerCase())}`;
}

function environmentsBase(host: string, environmentId: string): string {
  return `${host}/api/environments/${encodeURIComponent(environmentId)}`;
}

function collectEmails(person: Record<string, unknown>): string[] {
  const emails = new Set<string>();
  const properties = isRecord(person.properties) ? person.properties : null;
  for (const value of [properties?.email, properties?.$email]) {
    if (typeof value === 'string' && value.includes('@')) emails.add(value);
  }
  const distinctIds = Array.isArray(person.distinct_ids) ? person.distinct_ids : [];
  for (const value of distinctIds) {
    if (typeof value === 'string' && value.includes('@')) emails.add(value);
  }
  return [...emails];
}

function parsePersons(payload: unknown): ParsePersonsResult {
  if (!isRecord(payload) || !Array.isArray(payload.results)) return { kind: 'incomplete' };
  const byUuid = new Map<string, PosthogPerson>();
  let missingUuid = false;
  for (const entry of payload.results) {
    if (!isRecord(entry)) continue;
    const uuid = typeof entry.uuid === 'string' && entry.uuid.length > 0 ? entry.uuid : null;
    if (!uuid) {
      missingUuid = true;
      continue;
    }
    const existing = byUuid.get(uuid);
    const emails = collectEmails(entry);
    if (existing) {
      existing.emails = [...new Set([...existing.emails, ...emails])];
      continue;
    }
    byUuid.set(uuid, { uuid, emails });
  }
  if (missingUuid) return { kind: 'missing_uuid' };
  return { kind: 'ok', persons: [...byUuid.values()] };
}

function isAcceptedBulkDelete(status: number, body: unknown, ids: string[]): boolean {
  if (status !== 202 || !isRecord(body)) return false;
  const deletionErrors = Array.isArray(body.deletion_errors) ? body.deletion_errors : null;
  return (
    body.persons_found === ids.length &&
    body.persons_deleted === ids.length &&
    body.events_queued_for_deletion === true &&
    body.recordings_queued_for_deletion === true &&
    deletionErrors !== null &&
    deletionErrors.length === 0
  );
}

function posthogManual(): DeletionHandlerOutcome {
  return { kind: 'manual_action_required', errorCode: 'posthog_manual_required' };
}

function classifyPosthogResponse(response: Response): DeletionHandlerOutcome {
  if (response.status === 401 || response.status === 403) return posthogManual();
  return classifyResponse(response);
}

function decryptCheckpoint(progress: UserDeletionTaskProgress): string[] | null {
  if (!progress.encrypted_resource_ids) return null;
  try {
    return decryptDeletionResourceIds(progress.encrypted_resource_ids);
  } catch {
    return null;
  }
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

async function recordPosthogActivity(
  requestId: string,
  eventType: string,
  resourceHmac?: string
): Promise<void> {
  await db.transaction(async tx => {
    await writeDeletionActivity(tx, {
      requestId,
      stepKey: UserDeletionStepKey.Posthog,
      eventType,
      details: resourceHmac ? { resource_hmac: resourceHmac } : {},
    });
  });
}

async function extraKiloUserIds(
  targetEmail: string,
  subjectUserId: string | null,
  persons: PosthogPerson[]
): Promise<string[]> {
  const extraEmails = [
    ...new Set(
      persons.flatMap(person =>
        person.emails.filter(email => !deletionEmailsEqual(email, targetEmail))
      )
    ),
  ];
  const ids = new Set<string>();
  for (const email of extraEmails) {
    const users = (
      await db
        .select({ id: kilocode_users.id, blocked_reason: kilocode_users.blocked_reason })
        .from(kilocode_users)
        .where(eq(sql`lower(${kilocode_users.google_user_email})`, normalizeDeletionEmail(email)))
    ).filter(user => !isSoftDeletedBlockedReason(user.blocked_reason));
    for (const user of users) {
      if (subjectUserId && user.id === subjectUserId) continue;
      ids.add(user.id);
    }
  }
  return [...ids];
}

async function lookupPersons(
  context: DeletionHandlerContext,
  host: string,
  environmentId: string,
  headers: Record<string, string>,
  email: string
): Promise<{ persons: PosthogPerson[] } | { outcome: DeletionHandlerOutcome }> {
  const base = environmentsBase(host, environmentId);
  const merged = new Map<string, PosthogPerson>();
  for (const param of ['distinct_id', 'email'] as const) {
    const lookup = await deletionFetch(
      context,
      `${base}/persons/?${param}=${encodeURIComponent(email)}`,
      { headers }
    );
    if ('outcome' in lookup) return lookup;
    if (!lookup.response.ok) return { outcome: classifyPosthogResponse(lookup.response) };
    const parsed = parsePersons(await readJsonUnknown(lookup.response));
    if (parsed.kind === 'incomplete') {
      return { outcome: { kind: 'needs_attention', errorCode: 'posthog_lookup_incomplete' } };
    }
    if (parsed.kind === 'missing_uuid') {
      return { outcome: { kind: 'manual_action_required', errorCode: 'posthog_manual_required' } };
    }
    for (const person of parsed.persons) {
      const existing = merged.get(person.uuid);
      if (existing) {
        existing.emails = [...new Set([...existing.emails, ...person.emails])];
        continue;
      }
      merged.set(person.uuid, person);
    }
  }
  return { persons: [...merged.values()] };
}

function isCompletedDeletionStatus(
  entry: unknown,
  personUuid: string,
  checkpointMs: number
): boolean {
  if (!isRecord(entry)) return false;
  const createdAt =
    typeof entry.created_at === 'string' ? Date.parse(entry.created_at) : Number.NaN;
  return (
    entry.person_uuid === personUuid &&
    entry.status === 'completed' &&
    Number.isFinite(createdAt) &&
    createdAt >= checkpointMs &&
    typeof entry.delete_verified_at === 'string' &&
    entry.delete_verified_at.length > 0
  );
}

async function personsVerifiedGone(
  context: DeletionHandlerContext,
  host: string,
  environmentId: string,
  headers: Record<string, string>,
  personIds: string[],
  checkpointAt: string | undefined
): Promise<{ gone: true } | { pending: true } | { outcome: DeletionHandlerOutcome }> {
  const checkpointMs = checkpointAt ? Date.parse(checkpointAt) : Number.NaN;
  if (!Number.isFinite(checkpointMs)) {
    return { outcome: { kind: 'needs_attention', errorCode: 'posthog_checkpoint_invalid' } };
  }
  const base = environmentsBase(host, environmentId);
  for (const personId of personIds) {
    const pollStop = continueIfLowTime(context);
    if (pollStop) return { outcome: pollStop };

    const poll = await deletionFetch(context, `${base}/persons/${encodeURIComponent(personId)}/`, {
      headers,
    });
    if ('outcome' in poll) return poll;
    if (poll.response.status !== 404) {
      if (!poll.response.ok) return { outcome: classifyPosthogResponse(poll.response) };
      return { pending: true };
    }

    const statusUrl = new URL(`${base}/persons/deletion_status/`);
    statusUrl.searchParams.set('person_uuid', personId);
    statusUrl.searchParams.set('status', 'all');
    const statusPoll = await deletionFetch(context, statusUrl.toString(), { headers });
    if ('outcome' in statusPoll) return statusPoll;
    if (!statusPoll.response.ok) return { outcome: classifyPosthogResponse(statusPoll.response) };
    const body = await readJsonUnknown(statusPoll.response);
    if (!isRecord(body) || !Array.isArray(body.results)) {
      return { pending: true };
    }
    const completed = body.results.some(entry =>
      isCompletedDeletionStatus(entry, personId, checkpointMs)
    );
    if (!completed) return { pending: true };
  }
  return { gone: true };
}

async function verifyPersonsGone(
  context: DeletionHandlerContext,
  requestId: string,
  host: string,
  environmentId: string,
  headers: Record<string, string>,
  progress: UserDeletionTaskProgress,
  personIds: string[]
): Promise<DeletionHandlerOutcome> {
  if (personIds.length === 0) {
    return { kind: 'needs_attention', errorCode: 'posthog_checkpoint_invalid' };
  }

  const verified = await personsVerifiedGone(
    context,
    host,
    environmentId,
    headers,
    personIds,
    progress.checkpoint_at
  );
  if ('outcome' in verified) return verified.outcome;
  if ('gone' in verified) return { kind: 'succeeded', progress };

  const nextCount = (progress.verify_attempt_count ?? 0) + 1;
  if (nextCount <= USER_DELETION_POSTHOG_MAX_VERIFY_ATTEMPTS) {
    const nextProgress = { ...progress, verify_attempt_count: nextCount };
    const lost = await assertCurrentClaim(context);
    if (lost) return lost;
    await saveProgress(requestId, nextProgress);
    return { kind: 'continue', progress: nextProgress };
  }

  const lost = await assertCurrentClaim(context);
  if (lost) return lost;
  await recordPosthogActivity(requestId, 'posthog_verify_unconfirmed');
  return { kind: 'succeeded', progress };
}

export const handlePosthog: DeletionHandler = async ({ request, step, context }) => {
  const stop = continueIfLowTime(context);
  if (stop) return stop;

  const emailOrOutcome = requireTargetEmail(request);
  if (typeof emailOrOutcome !== 'string') return emailOrOutcome;

  const apiKey = getEnvVariable('POSTHOG_PERSONAL_API_KEY').trim();
  const environmentId = getEnvVariable('POSTHOG_ENVIRONMENT_ID').trim();
  if (!apiKey || !environmentId) return posthogManual();

  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const host = posthogHost();
  let progress = step.progress_json;

  if (progress.provider_ref && progress.provider_ref !== 'reserved') {
    const personIds = decryptCheckpoint(progress);
    if (!personIds) {
      return { kind: 'needs_attention', errorCode: 'posthog_checkpoint_invalid' };
    }
    return verifyPersonsGone(
      context,
      request.id,
      host,
      environmentId,
      headers,
      progress,
      personIds
    );
  }

  let personIds: string[] = [];
  if (progress.encrypted_resource_ids) {
    const decrypted = decryptCheckpoint(progress);
    if (!decrypted) {
      return { kind: 'needs_attention', errorCode: 'posthog_checkpoint_invalid' };
    }
    personIds = decrypted;
  }

  const lookup = await lookupPersons(context, host, environmentId, headers, emailOrOutcome);
  if ('outcome' in lookup) return lookup.outcome;

  if (lookup.persons.length === 0) {
    if (progress.provider_ref !== 'reserved') {
      return { kind: 'not_applicable' };
    }
    if (personIds.length === 0) {
      return { kind: 'needs_attention', errorCode: 'posthog_checkpoint_invalid' };
    }
    return verifyPersonsGone(
      context,
      request.id,
      host,
      environmentId,
      headers,
      progress,
      personIds
    );
  }

  const extraUserIds = await extraKiloUserIds(emailOrOutcome, request.user_id, lookup.persons);
  for (const userId of extraUserIds) {
    await recordPosthogActivity(request.id, 'posthog_shared_identity', hmacResourceRef(userId));
  }

  personIds = [...new Set(lookup.persons.map(person => person.uuid))];

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

  const checkpointAt = new Date().toISOString();
  const submit = await deletionFetch(
    context,
    `${environmentsBase(host, environmentId)}/persons/bulk_delete/`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ids: personIds,
        delete_events: true,
        delete_recordings: true,
        keep_person: false,
      }),
    }
  );
  if ('outcome' in submit) return submit.outcome;
  if (submit.response.status === 401 || submit.response.status === 403) return posthogManual();
  if (
    submit.response.status === 429 ||
    submit.response.status === 408 ||
    submit.response.status >= 500
  ) {
    return classifyResponse(submit.response);
  }

  const accepted = await readJsonUnknown(submit.response);
  if (!isAcceptedBulkDelete(submit.response.status, accepted, personIds)) {
    return { kind: 'needs_attention', errorCode: 'posthog_acceptance_incomplete' };
  }

  const providerRef =
    isRecord(accepted) && typeof accepted.id === 'string'
      ? accepted.id
      : isRecord(accepted) && typeof accepted.request_id === 'string'
        ? accepted.request_id
        : 'submitted';
  const lostBeforeConfirm = await assertCurrentClaim(context);
  if (lostBeforeConfirm) return lostBeforeConfirm;
  progress = {
    ...progress,
    provider_ref: providerRef,
    encrypted_resource_ids: encryptDeletionResourceIds(personIds),
    checkpoint_at: checkpointAt,
  };
  await saveProgress(request.id, progress);

  return verifyPersonsGone(context, request.id, host, environmentId, headers, progress, personIds);
};
