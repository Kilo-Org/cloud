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
  flowBinder,
  logSignInOutcome,
  newAccountId,
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
import { isSameOriginPost } from '../requests';

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

/** `a…@example.com`: enough for the owner to recognise the address, little for anyone else. */
function maskedAddress(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}…@${domain}`;
}

/** The binder cookie of one sign-in email, named after its link hash, like a flow's. */
function emailCookieName(linkHash: Uint8Array): string {
  const hex = [...linkHash.slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `__Host-uts_email_${hex}`;
}

const EMAIL_COOKIE_MAX_AGE_SECONDS = 600;

function codeEntryPage(email: string, withCode: boolean, message: string | null, status = 200) {
  const address = maskedAddress(email);
  const intro = withCode
    ? `We sent a sign-in link and a six-digit code to ${address}. Open the link, or enter the code here. Both work for 10 minutes.`
    : `We sent a sign-in link to ${address}. It works for 10 minutes.`;
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

/**
 * The link's confirmation page. It names the account's address; opened in another browser than
 * the one that asked for the email, it says so and its button confirms that, because a link
 * someone else asked for would sign the reader into that person's account.
 */
function linkConfirmPage(token: string, email: string, sameBrowser: boolean): Response {
  const address = escapeHtml(maskedAddress(email));
  const text = sameBrowser
    ? `<p>Sign in as ${address}?</p>`
    : `<p>This sign-in link was requested in another browser. Sign in as ${address} only if you asked for it yourself; if you did not, close this page.</p>`;
  return page(
    'Sign in to Kilo',
    'email-link',
    `${text}
<form method="post" action="${UTS_EMAIL_LINK_PATH}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
${sameBrowser ? '' : '<input type="hidden" name="other_browser" value="confirmed">\n'}<button type="submit">Sign in as ${address}</button>
</form>`
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
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
    const linkHash = await sha256(token);
    let read;
    try {
      read = await methods.store(store => store.readEmailLink(linkHash));
    } catch (error) {
      return unavailablePage(classifyFailure(error, 'email_link_page') === 'retryable');
    }
    if (read === null) return refusalPage('invalid_link', null);
    const binder = flowBinder(request, emailCookieName(linkHash));
    const sameBrowser = binder !== null && sameBytes(await sha256(binder), read.binderHash);
    return linkConfirmPage(token, read.email, sameBrowser);
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
    const linkHash = await sha256(linkToken);
    const binder = randomCredential();
    const code = newCode();
    const { emailHash, codeHash } = await emailHashes(hashKey, email, code);
    let stored;
    try {
      stored = await methods.store(async store =>
        store.startEmail({
          email,
          emailHash,
          linkHash,
          codeHash,
          binderHash: await sha256(binder),
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
    const response = codeEntryPage(email, stored.withCode, null);
    // Ties the email to this browser: its link signs in here without the other-browser warning.
    response.headers.append(
      'Set-Cookie',
      `${emailCookieName(linkHash)}=${binder}; Path=/; Max-Age=${EMAIL_COOKIE_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Lax`
    );
    return response;
  }

  const sessionToken = randomCredential();
  const sessionTokenHash = await sha256(sessionToken);

  if (pathname === UTS_EMAIL_CODE_PATH) {
    const email = normalizeEmail(form.get('email'));
    const code = form.get('code')?.trim() ?? '';
    if (email === null || !CODE_FORMAT.test(code)) {
      return messagePage('Sign in to Kilo', 'Enter the six-digit code from the email.', 400, null);
    }
    const { emailHash, codeHash } = await emailHashes(hashKey, email, code);
    let result;
    try {
      result = await methods.store(store =>
        store.verifyEmailCode({
          environment,
          emailHash,
          codeHash,
          sessionTokenHash,
          network,
          newAccountId: newAccountId(),
        })
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
    if (result.outcome === 'codes_stopped') return refusalPage('codes_stopped', null);
    return refusalPage(result.outcome, result.returnTo);
  }

  const token = form.get('token');
  if (token === null || !isRandomCredential(token)) return refusalPage('invalid_link', null);
  const linkHash = await sha256(token);
  const binder = flowBinder(request, emailCookieName(linkHash));
  let result;
  try {
    result = await methods.store(async store =>
      store.completeEmailLink({
        environment,
        linkHash,
        binderHash: binder === null ? null : await sha256(binder),
        otherBrowser: form.get('other_browser') === 'confirmed',
        sessionTokenHash,
        network,
        newAccountId: newAccountId(),
      })
    );
  } catch (error) {
    return unavailablePage(classifyFailure(error, 'email_link') === 'retryable');
  }
  if (result.outcome === 'signed_in') {
    return signedInRedirect(sessionToken, result.returnTo, [
      `${emailCookieName(linkHash)}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    ]);
  }
  logSignInOutcome('email_link', null, result.outcome);
  if (result.outcome === 'confirm_other_browser') {
    return messagePage(
      'Sign in to Kilo',
      'This sign-in link was requested in another browser. Open the link from the email again to confirm.',
      409,
      null
    );
  }
  return refusalPage(result.outcome, result.outcome === 'invalid_link' ? null : result.returnTo);
}
