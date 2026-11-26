import {
  UTS_EMAIL_CODE_PATH,
  UTS_EMAIL_LINK_PATH,
  UTS_EMAIL_START_PATH,
} from '@kilocode/uts-contracts';
import { classifyFailure } from '../../oauth/errors';
import { jsonResponse } from '../../responses';
import { isRandomCredential, randomCredential, sha256 } from '../../token/credentials';
import {
  type SignInMethods,
  isSameOriginPost,
  logSignInOutcome,
  readForm,
  refusalPage,
  returnPathOf,
  signedInRedirect,
  upstreamFailurePage,
} from '../flows';
import { escapeHtml, messagePage, page, unavailablePage } from '../pages';
import { logMisconfigured } from '../providers/config';
import { normalizeEmail } from '../providers/exchange';
import { requestNetwork } from '../network';

/**
 * Email sign-in (design 5.1, 5.3): one email carries a link and, unless codes are stopped for the
 * address, a six-digit code; both live 10 minutes.
 *
 * * `POST /signin/email/start` (a form of the sign-in page) stores the email's hashes in one
 *   statement, then hands the message to the mail port, and shows the code entry.
 * * `POST /signin/email/code` checks the newest code sent to the address. The fifth wrong entry
 *   exhausts the code; the email's link still works, so wrong entries by someone else cannot lock
 *   the address's owner out (design 5.3).
 * * `GET /signin/email/link` only shows a confirmation page: a mail scanner that opens the link
 *   changes nothing. Its button posts the token to `POST /signin/email/link`.
 *
 * The address and the code are stored only as HMAC-SHA-256 values under `SIGNIN_EMAIL_HASH_KEY`
 * (a code has a million values, so a plain hash would fall to a table), and the link token as its
 * SHA-256. Every form post must come from the issuer's own pages (`Origin`), so another site
 * cannot sign a visitor into an account it chose.
 */

const CODE_DIGITS = 6;
const CODE_FORMAT = /^\d{6}$/;

/** A uniform six-digit code: rejection sampling over 32-bit values. */
function newCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    if (value < limit) return String(value % 1_000_000).padStart(CODE_DIGITS, '0');
  }
}

async function keyedHash(key: Uint8Array, label: string, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(`${label}:${value}`))
  );
}

/** The keyed hashes of an address and of a code sent to it; a code's hash names its address. */
export async function emailHashes(
  key: Uint8Array,
  email: string,
  code: string
): Promise<{ emailHash: Uint8Array; codeHash: Uint8Array }> {
  return {
    emailHash: await keyedHash(key, 'kilo-uts-email', email),
    codeHash: await keyedHash(key, 'kilo-uts-email-code', `${email}:${code}`),
  };
}

function codeEntryPage(email: string, withCode: boolean, message: string | null, status = 200) {
  const intro = withCode
    ? 'We sent a sign-in link and a six-digit code to your email address. Open the link, or enter the code here. Both work for 10 minutes.'
    : 'We sent a sign-in link to your email address. It works for 10 minutes.';
  const form = withCode
    ? `<form method="post" action="${UTS_EMAIL_CODE_PATH}">
<input type="hidden" name="email" value="${escapeHtml(email)}">
<label for="email-code">Code</label>
<input id="email-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
<button type="submit">Sign in</button>
</form>`
    : '';
  const note = message === null ? '' : `<p>${escapeHtml(message)}</p>\n`;
  return page(
    'Check your email',
    'email-code',
    `${note}<p>${escapeHtml(intro)}</p>\n${form}`,
    status
  );
}

function linkConfirmPage(token: string): Response {
  return page(
    'Sign in to Kilo',
    'email-link',
    `<p>Continue to sign in with the link from your email.</p>
<form method="post" action="${UTS_EMAIL_LINK_PATH}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Sign in</button>
</form>`
  );
}

export async function handleEmailRequest(
  request: Request,
  pathname: string,
  methods: SignInMethods
): Promise<Response | null> {
  if (
    pathname !== UTS_EMAIL_START_PATH &&
    pathname !== UTS_EMAIL_CODE_PATH &&
    pathname !== UTS_EMAIL_LINK_PATH
  ) {
    return null;
  }
  const keySetting = methods.settings.emailHashKey;
  if (keySetting.status === 'off' || methods.mailer === null) return null;
  if (keySetting.status === 'misconfigured') {
    logMisconfigured('email', keySetting.missing);
    return messagePage('Sign in to Kilo', 'Email sign-in is not available.', 500, null);
  }
  const { hashKey } = keySetting;
  const mailer = methods.mailer;
  const { environment, endpoints } = methods.config;

  if (pathname === UTS_EMAIL_LINK_PATH && request.method === 'GET') {
    const token = new URL(request.url).searchParams.get('token');
    if (token === null || !isRandomCredential(token)) return refusalPage('invalid_link', null);
    return linkConfirmPage(token);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  }
  if (!isSameOriginPost(request)) return jsonResponse({ error: 'forbidden_origin' }, 403);
  const form = await readForm(request);
  if (form === null) return jsonResponse({ error: 'invalid_request' }, 400);
  const network = requestNetwork(request);

  if (pathname === UTS_EMAIL_START_PATH) {
    const returnTo = returnPathOf(form.get('return_to'));
    const email = normalizeEmail(form.get('email'));
    if (email === null) {
      return messagePage('Sign in to Kilo', 'Enter a valid email address.', 400, returnTo);
    }
    const linkToken = randomCredential();
    const code = newCode();
    const { emailHash, codeHash } = await emailHashes(hashKey, email, code);
    let stored;
    try {
      stored = await methods.store(async store =>
        store.startEmail({
          email,
          emailHash,
          linkHash: await sha256(linkToken),
          codeHash,
          returnTo,
        })
      );
    } catch (error) {
      return unavailablePage(classifyFailure(error, 'email_start') === 'retryable');
    }
    if (stored.outcome === 'sso_required') {
      logSignInOutcome('email', null, stored.outcome);
      return refusalPage('sso_required', returnTo);
    }
    const sent = await mailer({
      to: email,
      link: `${endpoints.issuer}${UTS_EMAIL_LINK_PATH}?token=${linkToken}`,
      code: stored.withCode ? code : null,
      expiresAt: stored.expiresAt,
    });
    if (sent !== 'sent') {
      console.error(JSON.stringify({ event: 'uts.signin.mail_failed', result: sent }));
      return upstreamFailurePage(sent === 'retryable', returnTo);
    }
    return codeEntryPage(email, stored.withCode, null);
  }

  const sessionToken = randomCredential();
  const sessionTokenHash = await sha256(sessionToken);

  if (pathname === UTS_EMAIL_CODE_PATH) {
    const email = normalizeEmail(form.get('email'));
    const code = form.get('code')?.trim() ?? '';
    if (email === null || !CODE_FORMAT.test(code)) {
      return codeEntryPage(email ?? '', true, 'Enter the six-digit code from the email.', 400);
    }
    const { emailHash, codeHash } = await emailHashes(hashKey, email, code);
    let result;
    try {
      result = await methods.store(store =>
        store.verifyEmailCode({ environment, emailHash, codeHash, sessionTokenHash, network })
      );
    } catch (error) {
      return unavailablePage(classifyFailure(error, 'email_code') === 'retryable');
    }
    if (result.outcome === 'signed_in') return signedInRedirect(sessionToken, result.returnTo);
    logSignInOutcome('email_code', null, result.outcome);
    if (result.outcome === 'invalid_code') {
      const message =
        result.entriesLeft > 0
          ? `That code is not right. ${result.entriesLeft} tries left.`
          : 'No code is waiting for this address. Request a new email.';
      return codeEntryPage(email, result.entriesLeft > 0, message, 400);
    }
    return refusalPage(result.outcome, result.returnTo);
  }

  const token = form.get('token');
  if (token === null || !isRandomCredential(token)) return refusalPage('invalid_link', null);
  let result;
  try {
    result = await methods.store(async store =>
      store.completeEmailLink({
        environment,
        linkHash: await sha256(token),
        sessionTokenHash,
        network,
      })
    );
  } catch (error) {
    return unavailablePage(classifyFailure(error, 'email_link') === 'retryable');
  }
  if (result.outcome === 'signed_in') return signedInRedirect(sessionToken, result.returnTo);
  logSignInOutcome('email_link', null, result.outcome);
  return refusalPage(result.outcome, result.outcome === 'invalid_link' ? null : result.returnTo);
}
