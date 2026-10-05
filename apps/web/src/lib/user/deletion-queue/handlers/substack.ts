import { eq } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { user_deletion_provider_credentials } from '@kilocode/db/schema';
import {
  UserDeletionProviderScope,
  type UserDeletionTaskProgress,
} from '@kilocode/db/schema-types';
import { getEnvVariable } from '@/lib/dotenvx';
import { db } from '@/lib/drizzle';
import {
  USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL,
  USER_DELETION_SUBSTACK_PAGE_SIZE,
  USER_DELETION_SUBSTACK_TIMEOUT_MS,
  USER_DELETION_SUBSTACK_USER_AGENT,
} from '@/lib/user/deletion-queue/deletion-constants';
import {
  decryptDeletionCredential,
  DeletionCryptoError,
} from '@/lib/user/deletion-queue/deletion-crypto';
import { classifyFetchFailure, classifyHttpStatus } from '@/lib/user/deletion-queue/deletion-http';
import {
  parseSubstackCredential,
  persistRefreshedSubstackCookie,
  type SubstackCredentialParseResult,
} from '@/lib/user/deletion-queue/deletion-substack-credential';
import {
  applyResponseCookies,
  reauthenticateSubstackSession,
  type SubstackReauthFailure,
} from '@/lib/user/deletion-queue/substack-session';
import {
  classifyResponse,
  continueIfLowTime,
  incrementProcessed,
  isRecord,
  readJsonUnknown,
  requireTargetEmail,
  shouldStopStarting,
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

function reauthFailureOutcome(
  failure: SubstackReauthFailure,
  progress: UserDeletionTaskProgress | undefined
): DeletionHandlerOutcome {
  switch (failure.kind) {
    case 'low_time':
      return { kind: 'continue', progress };
    case 'fetch_failed':
      if (failure.errorCode === 'redirect') {
        return { kind: 'needs_attention', errorCode: 'substack_redirect_blocked' };
      }
      if (failure.errorCode === 'timeout') {
        return { kind: 'retry', errorCode: 'timeout', httpStatusClass: 'timeout' };
      }
      return { kind: 'retry', errorCode: 'connection_failure', httpStatusClass: 'network' };
    case 'http':
      if (failure.status === 401)
        return { kind: 'manual_action_required', errorCode: 'credential_expired' };
      if (failure.status === 403)
        return { kind: 'manual_action_required', errorCode: 'substack_forbidden' };
      if (failure.status === 429) return { kind: 'rate_limited', retryAfterMs: 60_000 };
      if (failure.status === 400 || failure.status === 422) {
        return { kind: 'manual_action_required', errorCode: 'substack_reauth_rejected' };
      }
      return classifyHttpStatus(failure.status);
    case 'method_unsupported':
      return { kind: 'manual_action_required', errorCode: 'substack_reauth_method_unsupported' };
    case 'error_payload':
      return { kind: 'manual_action_required', errorCode: 'substack_reauth_rejected' };
    case 'incomplete':
      return { kind: 'manual_action_required', errorCode: 'substack_reauth_incomplete' };
    case 'invalid_totp_secret':
      return { kind: 'manual_action_required', errorCode: 'substack_totp_invalid' };
  }
}

function parseFailureOutcome(
  parsed: Extract<SubstackCredentialParseResult, { ok: false }>
): DeletionHandlerOutcome {
  return {
    kind: 'manual_action_required',
    errorCode: parsed.reason === 'invalid_totp' ? 'substack_totp_invalid' : 'credential_missing',
  };
}

export const handleSubstack: DeletionHandler = async ({ request, step, context }) => {
  let currentCookie = '';
  let totpSecret: string | null = null;
  let originalEncryptedMaterial = '';
  let cookieChanged = false;

  const syncCookies = (response: Response) => {
    const next = applyResponseCookies(currentCookie, response);
    if (next !== currentCookie) {
      currentCookie = next;
      cookieChanged = true;
    }
  };

  const run = async (): Promise<DeletionHandlerOutcome> => {
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

    let parsed: SubstackCredentialParseResult;
    try {
      parsed = parseSubstackCredential(decryptDeletionCredential(credential.encrypted_material));
    } catch (error) {
      if (error instanceof DeletionCryptoError) {
        return { kind: 'manual_action_required', errorCode: 'credential_missing' };
      }
      throw error;
    }
    if (!parsed.ok) return parseFailureOutcome(parsed);

    currentCookie = parsed.credential.cookie;
    totpSecret = parsed.credential.totpSecret;
    originalEncryptedMaterial = credential.encrypted_material;

    const headers = () => ({
      Cookie: currentCookie,
      Accept: 'application/json',
      'User-Agent': USER_DELETION_SUBSTACK_USER_AGENT,
    });

    const targetEmail = emailOrOutcome.trim().toLowerCase();
    let found = false;
    let count: number | undefined;
    let complete = false;
    const seenEmails = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const reserve = continueIfLowTime(context, step.progress_json);
      if (reserve) return reserve;
      const lookup = await substackFetch(context, `${publication}/api/v1/subscriber-stats`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filters: { search: targetEmail, order_by_desc_nulls_last: 'subscription_created_at' },
          limit: USER_DELETION_SUBSTACK_PAGE_SIZE,
          offset: page * USER_DELETION_SUBSTACK_PAGE_SIZE,
          includeTags: true,
        }),
      });
      if ('outcome' in lookup) return lookup.outcome;
      syncCookies(lookup.response);
      if (lookup.response.status === 401) {
        return { kind: 'manual_action_required', errorCode: 'credential_expired' };
      }
      if (lookup.response.status === 403) {
        return { kind: 'manual_action_required', errorCode: 'substack_forbidden' };
      }
      if (!lookup.response.ok) return classifyResponse(lookup.response);

      const payload = await readJsonUnknown(lookup.response);
      if (
        !isRecord(payload) ||
        !Array.isArray(payload.subscribers) ||
        typeof payload.count !== 'number' ||
        !Number.isSafeInteger(payload.count) ||
        payload.count < 0 ||
        (count !== undefined && payload.count !== count) ||
        payload.subscribers.length !==
          Math.min(
            USER_DELETION_SUBSTACK_PAGE_SIZE,
            payload.count - page * USER_DELETION_SUBSTACK_PAGE_SIZE
          )
      ) {
        return { kind: 'manual_action_required', errorCode: 'substack_lookup_incomplete' };
      }
      count = payload.count;
      const emails: string[] = [];
      for (const subscriber of payload.subscribers) {
        if (
          !isRecord(subscriber) ||
          typeof subscriber.user_email_address !== 'string' ||
          !subscriber.user_email_address.trim()
        ) {
          return { kind: 'manual_action_required', errorCode: 'substack_lookup_incomplete' };
        }
        emails.push(subscriber.user_email_address.trim().toLowerCase());
      }
      if (emails.includes(targetEmail)) {
        found = true;
      }
      for (const email of emails) {
        if (seenEmails.has(email)) {
          return { kind: 'manual_action_required', errorCode: 'substack_lookup_incomplete' };
        }
        seenEmails.add(email);
      }
      if ((page + 1) * USER_DELETION_SUBSTACK_PAGE_SIZE >= count) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      return { kind: 'manual_action_required', errorCode: 'substack_lookup_incomplete' };
    }
    if (!found) {
      return (step.progress_json.processed_count ?? 0) === 0
        ? { kind: 'not_applicable' }
        : { kind: 'succeeded', progress: incrementProcessed(step.progress_json, 0) };
    }

    const reserve = continueIfLowTime(context, step.progress_json);
    if (reserve) return reserve;

    if (totpSecret) {
      const reauth = await reauthenticateSubstackSession({
        publication,
        cookie: currentCookie,
        totpSecret,
        guard: () => !shouldStopStarting(context),
        signal: context.signal,
        timeoutMs: USER_DELETION_SUBSTACK_TIMEOUT_MS,
      });
      if (reauth.cookie !== currentCookie) {
        currentCookie = reauth.cookie;
        cookieChanged = true;
      }
      if (!reauth.ok) return reauthFailureOutcome(reauth.failure, step.progress_json);

      const afterReauth = continueIfLowTime(context, step.progress_json);
      if (afterReauth) return afterReauth;
    }

    const remove = await substackFetch(
      context,
      `${publication}/api/v1/subscriber/${encodeURIComponent(targetEmail)}?disable_email=true`,
      {
        method: 'DELETE',
        headers: headers(),
      }
    );
    if ('outcome' in remove) return remove.outcome;
    syncCookies(remove.response);
    if (remove.response.status === 401) {
      return { kind: 'manual_action_required', errorCode: 'credential_expired' };
    }
    if (remove.response.status === 403) {
      return { kind: 'manual_action_required', errorCode: 'substack_forbidden' };
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

  const outcome = await run();
  if (cookieChanged && currentCookie.trim()) {
    try {
      await persistRefreshedSubstackCookie({
        originalEncryptedMaterial,
        cookie: currentCookie,
        totpSecret,
      });
    } catch {
      captureException(new Error('Substack refreshed cookie persistence failed'), {
        tags: { source: 'user-deletion-handler', stepKey: 'substack' },
      });
    }
  }
  return outcome;
};
