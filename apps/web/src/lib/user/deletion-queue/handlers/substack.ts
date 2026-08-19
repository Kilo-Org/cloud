import { eq } from 'drizzle-orm';
import { user_deletion_provider_credentials } from '@kilocode/db/schema';
import { UserDeletionProviderScope } from '@kilocode/db/schema-types';
import { getEnvVariable } from '@/lib/dotenvx';
import { db } from '@/lib/drizzle';
import {
  USER_DELETION_RESOURCE_BATCH_SIZE,
  USER_DELETION_SUBSTACK_PAGE_SIZE,
} from '@/lib/user/deletion-queue/deletion-constants';
import {
  decryptDeletionCredential,
  DeletionCryptoError,
} from '@/lib/user/deletion-queue/deletion-crypto';
import { deletionEmailsEqual } from '@/lib/user/deletion-queue/deletion-intake';
import { cookieFromCredential } from '@/lib/user/deletion-queue/deletion-substack-credential';
import {
  classifyResponse,
  continueIfLowTime,
  deletionFetch,
  incrementProcessed,
  isRecord,
  readJsonUnknown,
  requireTargetEmail,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';

type SubstackSubscriber = {
  id: string;
  email: string;
};

function parseSubscribers(payload: unknown): SubstackSubscriber[] | null {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.subscribers)
      ? payload.subscribers
      : isRecord(payload) && Array.isArray(payload.data)
        ? payload.data
        : null;
  if (!list) return null;

  const subscribers: SubstackSubscriber[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) return null;
    const email =
      typeof entry.email === 'string'
        ? entry.email
        : isRecord(entry.user) && typeof entry.user.email === 'string'
          ? entry.user.email
          : null;
    const id =
      typeof entry.id === 'string' || typeof entry.id === 'number'
        ? String(entry.id)
        : typeof entry.user_id === 'string' || typeof entry.user_id === 'number'
          ? String(entry.user_id)
          : isRecord(entry.user) &&
              (typeof entry.user.id === 'string' || typeof entry.user.id === 'number')
            ? String(entry.user.id)
            : null;
    if (!email || !id) return null;
    subscribers.push({ id, email });
  }
  return subscribers;
}

export const handleSubstack: DeletionHandler = async ({ request, step, context }) => {
  const stop = continueIfLowTime(context, step.progress_json);
  if (stop) return stop;

  const emailOrOutcome = requireTargetEmail(request);
  if (typeof emailOrOutcome !== 'string') return emailOrOutcome;

  const publication = getEnvVariable('SUBSTACK_PUBLICATION_URL').trim().replace(/\/$/, '');
  if (!publication) {
    return { kind: 'needs_attention', errorCode: 'configuration_missing' };
  }

  const [credential] = await db
    .select()
    .from(user_deletion_provider_credentials)
    .where(
      eq(user_deletion_provider_credentials.provider_scope, UserDeletionProviderScope.Substack)
    )
    .limit(1);
  if (!credential) {
    return { kind: 'manual_action_required', errorCode: 'credential_missing' };
  }

  let cookie: string | null;
  try {
    cookie = cookieFromCredential(decryptDeletionCredential(credential.encrypted_material));
  } catch (error) {
    if (error instanceof DeletionCryptoError) {
      return { kind: 'manual_action_required', errorCode: 'credential_missing' };
    }
    throw error;
  }
  if (!cookie) {
    return { kind: 'manual_action_required', errorCode: 'credential_missing' };
  }

  const offset = step.progress_json.page_offset ?? 0;
  const lookup = await deletionFetch(
    context,
    `${publication}/api/v1/subscriber?offset=${offset}&limit=${USER_DELETION_SUBSTACK_PAGE_SIZE}`,
    { headers: { Cookie: cookie, Accept: 'application/json' } }
  );
  if ('outcome' in lookup) return lookup.outcome;
  if (lookup.response.status === 401 || lookup.response.status === 403) {
    return { kind: 'manual_action_required', errorCode: 'credential_expired' };
  }
  if (!lookup.response.ok) return classifyResponse(lookup.response);

  const subscribers = parseSubscribers(await readJsonUnknown(lookup.response));
  if (!subscribers) {
    return { kind: 'needs_attention', errorCode: 'substack_lookup_incomplete' };
  }

  const matches = subscribers.filter(subscriber =>
    deletionEmailsEqual(subscriber.email, emailOrOutcome)
  );
  let progress = incrementProcessed(
    {
      ...step.progress_json,
      page_offset: offset,
      clean_pass: step.progress_json.clean_pass ?? true,
    },
    0
  );
  let deleted = 0;

  for (const match of matches.slice(0, USER_DELETION_RESOURCE_BATCH_SIZE)) {
    const reserve = continueIfLowTime(context, progress);
    if (reserve) return reserve;

    const remove = await deletionFetch(
      context,
      `${publication}/api/v1/subscriber/${encodeURIComponent(match.id)}`,
      { method: 'DELETE', headers: { Cookie: cookie, Accept: 'application/json' } }
    );
    if ('outcome' in remove) return remove.outcome;
    if (remove.response.status === 401 || remove.response.status === 403) {
      return { kind: 'manual_action_required', errorCode: 'credential_expired' };
    }
    if (!remove.response.ok && remove.response.status !== 404) {
      return classifyResponse(remove.response);
    }
    deleted += 1;
    progress = incrementProcessed(progress);
  }

  if (deleted > 0) {
    return {
      kind: 'continue',
      progress: { ...progress, page_offset: 0, clean_pass: false },
    };
  }

  if (subscribers.length >= USER_DELETION_SUBSTACK_PAGE_SIZE) {
    return {
      kind: 'continue',
      progress: {
        ...progress,
        page_offset: offset + USER_DELETION_SUBSTACK_PAGE_SIZE,
      },
    };
  }

  if (progress.clean_pass !== false && (progress.processed_count ?? 0) === 0) {
    return { kind: 'not_applicable' };
  }
  return { kind: 'succeeded', progress: { ...progress, page_offset: 0, clean_pass: true } };
};
