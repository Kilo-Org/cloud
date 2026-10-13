import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL,
  USER_DELETION_SUBSTACK_PAGE_SIZE,
  USER_DELETION_SUBSTACK_TIMEOUT_MS,
  USER_DELETION_SUBSTACK_USER_AGENT,
} from '@kilocode/web-shared/lib/user/deletion-queue/deletion-constants';
import {
  applyResponseCookies,
  isSubstackReauthRequired,
  reauthenticateSubstackSession,
} from '../apps/web/src/lib/user/deletion-queue/substack-session';
import { normalizeTotpSecret } from '../apps/web/src/lib/user/deletion-queue/substack-totp';

const USAGE = `Usage:
  pnpm exec tsx --tsconfig apps/web/tsconfig.json scripts/diagnose-substack.ts --email person@example.com [--publication https://blog.kilo.ai] [--delete]

Required environment: SUBSTACK_COOKIE (Cookie header or bare connect.sid value).
Optional environment: SUBSTACK_TOTP_SECRET (Base32 authenticator secret, NOT a six-digit code).
Publication defaults to SUBSTACK_PUBLICATION_URL or https://blog.kilo.ai.

Default: test the session and look up the exact subscriber; no deletion.
--delete: actually remove the exact subscriber, with disable_email=true, like admin.
Reauthentication can rotate the session cookie even in lookup-only mode.
No database access, saved credentials, raw response bodies, or credential logging.
`;

type DiagnosticOptions = {
  cookie: string;
  totpSecret?: string;
  email: string;
  publication?: string;
  deleteSubscriber?: boolean;
};

class DiagnosticError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function diagnoseSubstack(
  options: DiagnosticOptions,
  report: (event: Record<string, unknown>) => void = event => console.log(JSON.stringify(event))
): Promise<void> {
  const material = options.cookie.trim();
  if (
    !material ||
    material.length > 16_000 ||
    Array.from(material).some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new DiagnosticError(
      'Provide SUBSTACK_COOKIE as a Cookie header or bare connect.sid value.'
    );
  }
  let cookie = material.includes('=') ? material : `connect.sid=${material}`;
  const totpSecret = options.totpSecret?.trim() ? normalizeTotpSecret(options.totpSecret) : null;
  if (options.totpSecret?.trim() && !totpSecret) {
    throw new DiagnosticError('SUBSTACK_TOTP_SECRET must be a valid Base32 authenticator secret.');
  }
  const email = options.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new DiagnosticError('Provide a valid target subscriber email with --email.');
  }
  const input = options.publication?.trim() || USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL;
  let url: URL;
  try {
    const host = input.includes('.') ? input : `${input}.substack.com`;
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${host}`);
  } catch {
    throw new DiagnosticError('Invalid publication URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname === 'blog.kilo.ai' ||
      url.hostname === 'substack.com' ||
      url.hostname.endsWith('.substack.com')
    )
  ) {
    throw new DiagnosticError('Publication must be an HTTPS blog.kilo.ai or substack.com host.');
  }
  const publication = url.origin;
  report({
    stage: 'configuration',
    publication,
    mode: options.deleteSubscriber ? 'DELETE' : 'lookup-only',
    totpConfigured: Boolean(totpSecret),
  });

  async function request(
    stage: string,
    requestUrl: string,
    init: RequestInit,
    mergeCookies = true
  ): Promise<Response> {
    const send = async () => {
      let response: Response;
      try {
        response = await fetch(requestUrl, {
          ...init,
          headers: { ...init.headers, Cookie: cookie, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(USER_DELETION_SUBSTACK_TIMEOUT_MS),
        });
        const body = await response.clone().text();
        report({
          stage,
          host: new URL(requestUrl).host,
          method: init.method ?? 'GET',
          status: response.status,
          contentType: response.headers.get('content-type'),
          cloudflareChallenge: response.headers.get('cf-mitigated') === 'challenge',
          cloudflarePage: /cf-chl-|challenge-platform|Attention Required! \| Cloudflare/.test(body),
          reauthenticationRequired: await isSubstackReauthRequired(response),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const cause =
          error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
        const kind = /redirect/i.test(`${message} ${cause}`)
          ? 'redirect blocked'
          : /timeout|abort/i.test(`${message} ${cause}`)
            ? 'timeout'
            : 'network or response-read failure';
        throw new DiagnosticError(`${stage}: ${kind}.`);
      }
      if (mergeCookies) cookie = applyResponseCookies(cookie, response);
      return response;
    };

    const first = await send();
    if (!(await isSubstackReauthRequired(first))) return first;
    if (!totpSecret)
      throw new DiagnosticError(`${stage}: reauthentication requires SUBSTACK_TOTP_SECRET.`);
    const reauth = await reauthenticateSubstackSession({ publication, cookie, totpSecret });
    cookie = reauth.cookie;
    report({
      stage: `${stage}:reauthentication`,
      ok: reauth.ok,
      ...(reauth.ok ? { method: reauth.method } : { failure: reauth.failure }),
    });
    if (!reauth.ok)
      throw new DiagnosticError(`${stage}: reauthentication failed; see diagnostic above.`);
    const retry = await send();
    if (await isSubstackReauthRequired(retry)) {
      throw new DiagnosticError(`${stage}: reauthentication challenge persisted after one retry.`);
    }
    return retry;
  }

  const profile = await request('profile', `${publication}/api/v1/user/profile/self`, {});
  if (profile.status === 404 && publication !== 'https://substack.com') {
    await request('profile-fallback', 'https://substack.com/api/v1/user/profile/self', {}, false);
  }

  const headers = { 'User-Agent': USER_DELETION_SUBSTACK_USER_AGENT };
  let count: number | undefined;
  let found = false;
  let complete = false;
  const seenEmails = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
    const response = await request('subscriber-lookup', `${publication}/api/v1/subscriber-stats`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: { search: email, order_by_desc_nulls_last: 'subscription_created_at' },
        limit: USER_DELETION_SUBSTACK_PAGE_SIZE,
        offset: page * USER_DELETION_SUBSTACK_PAGE_SIZE,
        includeTags: true,
      }),
    });
    if (!response.ok) throw httpError('subscriber-lookup', response.status);
    const payload: unknown = await response.json();
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
      throw new DiagnosticError('Subscriber lookup incomplete or inconsistent; refusing deletion.');
    }
    count = payload.count;
    for (const subscriber of payload.subscribers) {
      if (
        !isRecord(subscriber) ||
        typeof subscriber.user_email_address !== 'string' ||
        !subscriber.user_email_address.trim()
      ) {
        throw new DiagnosticError(
          'Subscriber lookup returned an invalid email; refusing deletion.'
        );
      }
      const subscriberEmail = subscriber.user_email_address.trim().toLowerCase();
      if (seenEmails.has(subscriberEmail))
        throw new DiagnosticError('Duplicate subscriber across pages; refusing deletion.');
      seenEmails.add(subscriberEmail);
      if (subscriberEmail === email) found = true;
    }
    if ((page + 1) * USER_DELETION_SUBSTACK_PAGE_SIZE >= count) {
      complete = true;
      break;
    }
  }
  if (!complete)
    throw new DiagnosticError('Subscriber lookup exceeded 100 pages; refusing deletion.');
  report({
    stage: 'lookup-result',
    exactMatch: found,
    count,
    deletionRequested: Boolean(options.deleteSubscriber),
  });
  if (!found || !options.deleteSubscriber) return;

  const response = await request(
    'subscriber-delete',
    `${publication}/api/v1/subscriber/${encodeURIComponent(email)}?disable_email=true`,
    { method: 'DELETE', headers }
  );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const alreadyGone =
    response.status === 404 ||
    (response.status === 400 &&
      isRecord(payload) &&
      (payload.error === 'User not found' || payload.error === 'Subscription not found'));
  if (!response.ok && !alreadyGone) throw httpError('subscriber-delete', response.status);
  report({ stage: 'delete-result', result: alreadyGone ? 'already-removed' : 'removed' });
}

function httpError(stage: string, status: number): Error {
  const reason =
    status === 403
      ? 'Access denied; this does not establish session expiry. Check publication permissions and challenge indicators above.'
      : status === 401
        ? 'Session expired or unauthorized.'
        : 'Request failed.';
  return new DiagnosticError(`${stage}: HTTP ${status}. ${reason}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      publication: { type: 'string' },
      delete: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  await diagnoseSubstack({
    cookie: process.env.SUBSTACK_COOKIE ?? '',
    totpSecret: process.env.SUBSTACK_TOTP_SECRET,
    email: values.email ?? '',
    publication: values.publication ?? process.env.SUBSTACK_PUBLICATION_URL,
    deleteSubscriber: values.delete,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(
      error instanceof DiagnosticError
        ? error.message
        : 'Diagnostic failed. Check arguments and network access.'
    );
    process.exitCode = 1;
  });
}
