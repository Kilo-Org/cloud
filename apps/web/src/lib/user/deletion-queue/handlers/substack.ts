import { eq } from 'drizzle-orm';
import { user_deletion_provider_credentials } from '@kilocode/db/schema';
import { UserDeletionProviderScope } from '@kilocode/db/schema-types';
import { getEnvVariable } from '@/lib/dotenvx';
import { db } from '@/lib/drizzle';
import {
  USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL,
  USER_DELETION_SUBSTACK_TIMEOUT_MS,
  USER_DELETION_SUBSTACK_USER_AGENT,
} from '@/lib/user/deletion-queue/deletion-constants';
import {
  decryptDeletionCredential,
  DeletionCryptoError,
} from '@/lib/user/deletion-queue/deletion-crypto';
import { classifyFetchFailure } from '@/lib/user/deletion-queue/deletion-http';
import { cookieFromCredential } from '@/lib/user/deletion-queue/deletion-substack-credential';
import {
  classifyResponse,
  continueIfLowTime,
  incrementProcessed,
  isRecord,
  readJsonUnknown,
  requireTargetEmail,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';
import type {
  DeletionHandlerContext,
  DeletionHandlerOutcome,
} from '@/lib/user/deletion-queue/deletion-types';

const ALREADY_GONE_ERRORS = new Set(['User not found', 'Subscription not found']);

export function resolvePublicationBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL;

  let hostname: string;
  let localBaseUrl: string | undefined;
  try {
    const url = /^https?:\/\//i.test(trimmed) ? new URL(trimmed) : new URL(`https://${trimmed}`);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      throw new Error('invalid');
    }
    hostname = url.hostname.toLowerCase();
    const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost';
    if (isLoopback && process.env.NODE_ENV !== 'production') {
      localBaseUrl = `${url.protocol}//${url.host}`;
    } else if (url.port && url.port !== '80' && url.port !== '443') {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('Invalid Substack publication URL.');
  }

  if (localBaseUrl) return localBaseUrl;

  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && !hostname.includes('.')) {
    hostname = `${hostname}.substack.com`;
  }
  if (!isAllowedPublicationHost(hostname)) {
    throw new Error('Publication URL must be blog.kilo.ai or a substack.com host.');
  }
  return `https://${hostname}`;
}

function isAllowedPublicationHost(hostname: string): boolean {
  return (
    hostname === 'blog.kilo.ai' || hostname === 'substack.com' || hostname.endsWith('.substack.com')
  );
}

function isAlreadyRemovedDelete(status: number, payload: unknown): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  const error = isRecord(payload) ? payload.error : undefined;
  return typeof error === 'string' && ALREADY_GONE_ERRORS.has(error);
}

async function substackFetch(
  context: DeletionHandlerContext,
  url: string,
  init: RequestInit
): Promise<{ response: Response } | { outcome: DeletionHandlerOutcome }> {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        context.signal,
        AbortSignal.timeout(USER_DELETION_SUBSTACK_TIMEOUT_MS),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
    return { response };
  } catch (error) {
    if (isRedirectError(error)) {
      return { outcome: { kind: 'needs_attention', errorCode: 'substack_redirect_blocked' } };
    }
    return { outcome: classifyFetchFailure(error) };
  }
}

function isRedirectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/redirect/i.test(error.message)) return true;
  const cause = error.cause;
  return cause instanceof Error && /redirect/i.test(cause.message);
}

export const handleSubstack: DeletionHandler = async ({ request, step, context }) => {
  const stop = continueIfLowTime(context, step.progress_json);
  if (stop) return stop;

  const emailOrOutcome = requireTargetEmail(request);
  if (typeof emailOrOutcome !== 'string') return emailOrOutcome;

  let publication: string;
  try {
    publication = resolvePublicationBaseUrl(getEnvVariable('SUBSTACK_PUBLICATION_URL'));
  } catch {
    return { kind: 'needs_attention', errorCode: 'substack_publication_invalid' };
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

  const targetEmail = emailOrOutcome.trim().toLowerCase();
  const remove = await substackFetch(
    context,
    `${publication}/api/v1/subscriber/${encodeURIComponent(targetEmail)}?disable_email=true`,
    {
      method: 'DELETE',
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
        'User-Agent': USER_DELETION_SUBSTACK_USER_AGENT,
      },
    }
  );
  if ('outcome' in remove) return remove.outcome;
  if (remove.response.status === 401 || remove.response.status === 403) {
    return { kind: 'manual_action_required', errorCode: 'credential_expired' };
  }

  const payload = await readJsonUnknown(remove.response);
  const alreadyGone = isAlreadyRemovedDelete(remove.response.status, payload);
  if (alreadyGone) {
    if ((step.progress_json.processed_count ?? 0) === 0) {
      return { kind: 'not_applicable' };
    }
    return { kind: 'succeeded', progress: incrementProcessed(step.progress_json, 0) };
  }
  if (!remove.response.ok) return classifyResponse(remove.response);

  return {
    kind: 'succeeded',
    progress: incrementProcessed(step.progress_json),
  };
};
