import {
  UTS_DEVICE_VERIFICATION_PATH,
  UTS_EMAIL_START_PATH,
  UTS_SIGNIN_SCRIPT_PATH,
  UTS_SSO_START_PATH,
  type UtsOAuthProvider,
  utsProviderStartPath,
} from '@kilocode/uts-contracts';
import type { PendingDevice, UserCodeSource } from './store';

/**
 * The sign-in pages on the issuer origin (design 5.14). They are plain HTML with one same-origin
 * script (src/signin/script.ts), which runs the WebAuthn ceremonies and the device decision; no
 * inline script, no third-party resource, no framing. Every value a page shows is escaped.
 */

/**
 * `form-action` also governs where a form submission redirects, so a page whose form ends in an
 * app's redirect names that URI's scheme beside `'self'`.
 */
function contentSecurityPolicy(formAction: string): string {
  return `default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`;
}

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': contentSecurityPolicy("'self'"),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  // No referrer leaves for another origin. `no-referrer` would also make a browser send
  // `Origin: null` with the pages' own form posts, which `isSameOriginPost` then refuses.
  'Referrer-Policy': 'same-origin',
} as const;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ESCAPES[character] ?? character);
}

/** One page: `page` names what the script wires up (`data-page`). */
export function page(title: string, pageName: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="${UTS_SIGNIN_SCRIPT_PATH}" defer></script>
</head>
<body data-page="${escapeHtml(pageName)}">
<main>
<h1>${escapeHtml(title)}</h1>
${body}
<p id="status" role="status" aria-live="polite"></p>
<noscript><p>Sign-in needs JavaScript and a browser with passkey support.</p></noscript>
</main>
</body>
</html>
`;
  return new Response(html, { status, headers: SECURITY_HEADERS });
}

/** The sign-in methods the page offers besides the passkey (`signInChoices`, src/signin/flows.ts). */
export type SignInChoices = {
  /** The path the sign-in returns to: the authorization URL that showed the page, or another. */
  returnTo: string;
  providers: readonly { provider: UtsOAuthProvider; name: string }[];
  email: boolean;
  /** Whether the page offers SSO, which starts with the user's work address. */
  sso: boolean;
};

/**
 * The sign-in page an interaction shows. After a passkey sign-in the script reloads the same URL;
 * a provider, SSO or email sign-in returns to `returnTo`.
 */
export function signInPage(choices: SignInChoices): Response {
  const returnTo = escapeHtml(choices.returnTo);
  const returnQuery = escapeHtml(new URLSearchParams({ return_to: choices.returnTo }).toString());
  const parts = [
    '<p>Use a passkey saved for your Kilo account.</p>\n<button type="button" id="passkey-sign-in">Sign in with a passkey</button>',
  ];
  if (choices.providers.length > 0) {
    parts.push(
      `<ul>${choices.providers
        .map(
          ({ provider, name }) =>
            `<li><a href="${escapeHtml(utsProviderStartPath(provider))}?${returnQuery}">Continue with ${escapeHtml(name)}</a></li>`
        )
        .join('')}</ul>`
    );
  }
  if (choices.email) {
    parts.push(`<form method="post" action="${UTS_EMAIL_START_PATH}">
<input type="hidden" name="return_to" value="${returnTo}">
<label for="email-address">Email address</label>
<input id="email-address" name="email" type="email" autocomplete="email" maxlength="320" required>
<button type="submit">Email me a sign-in link and code</button>
</form>`);
  }
  if (choices.sso) {
    parts.push(`<form method="post" action="${UTS_SSO_START_PATH}">
<input type="hidden" name="return_to" value="${returnTo}">
<label for="sso-email">Work email address</label>
<input id="sso-email" name="email" type="email" autocomplete="email" maxlength="320" required>
<button type="submit">Sign in with SSO</button>
</form>`);
  }
  return page('Sign in to Kilo', 'sign-in', parts.join('\n'));
}

/**
 * The answer to the SSO start form: a page that navigates on to the identity provider. A form
 * post that answered with a redirect would put the provider's own redirects (WorkOS to the org's
 * identity provider) under the sign-in page's `form-action`, which browsers enforce on every hop;
 * a navigation from this page is not a form submission, so no hop is blocked.
 */
export function continuePage(message: string, url: string): Response {
  const target = escapeHtml(url);
  return page(
    'Sign in to Kilo',
    'continue',
    `<meta http-equiv="refresh" content="0;url=${target}">
<p>${escapeHtml(message)}</p>
<p><a href="${target}" id="continue">Continue</a></p>`
  );
}

/** A page that tells the user one thing, with a way back to `back` when there is one. */
export function messagePage(
  title: string,
  message: string,
  status: number,
  back: string | null
): Response {
  const link = back === null ? '' : `\n<p><a href="${escapeHtml(back)}">Back</a></p>`;
  return page(title, 'message', `<p>${escapeHtml(message)}</p>${link}`, status);
}

/** The page where a signed-in user adds a passkey (a tier A action, design 5.11). */
export function passkeysPage(): Response {
  return page(
    'Add a passkey',
    'passkeys',
    `<p>A passkey lets you sign in without a password.</p>
<label for="passkey-name">Passkey name</label>
<input id="passkey-name" name="name" maxlength="100" autocomplete="off" required>
<button type="button" id="passkey-register">Add a passkey</button>`
  );
}

/**
 * The device page: the user enters the code and posts it to the same path. A code that arrived in
 * the page's URL (`linked`) only fills the field; the hidden `linked_code` lets the POST tell a
 * code the user kept from one the user typed.
 */
export function deviceCodeEntryPage(message: string | null, linked: string | null): Response {
  const notice = message === null ? '' : `<p>${escapeHtml(message)}</p>\n`;
  const prefill =
    linked === null
      ? ''
      : `<p>Check that this code matches the code on your device.</p>
<input type="hidden" name="linked_code" value="${escapeHtml(linked)}">\n`;
  return page(
    'Sign in on a device',
    'device-entry',
    `${notice}<form method="post" action="${UTS_DEVICE_VERIFICATION_PATH}">
${prefill}<label for="user-code">Code shown on your device</label>
<input id="user-code" name="user_code" value="${escapeHtml(linked ?? '')}" autocomplete="off" autocapitalize="characters" maxlength="16" required>
<button type="submit">Continue</button>
</form>`
  );
}

/**
 * A device sign-in waiting for the user (RFC 8628 section 5.4): what asks, from where. `source`
 * goes back with the decision: a code from a link needs a passkey check to approve, so the page
 * tells a user without a passkey to type the code on the plain device page instead.
 */
export function deviceApprovalPage(
  userCode: string,
  source: UserCodeSource,
  clientName: string,
  device: PendingDevice
): Response {
  const place = [device.city, device.country].filter(part => part !== null).join(', ');
  const scopes = device.scopes.map(scope => `<li><code>${escapeHtml(scope)}</code></li>`).join('');
  const linkNotice =
    source === 'link'
      ? `\n<p>This code came in a link, so approving asks for your passkey. No passkey? <a id="type-code" href="${UTS_DEVICE_VERIFICATION_PATH}">Type the code from your device</a> instead.</p>`
      : '';
  return page(
    'Approve a device sign-in',
    'device-approval',
    `<p>Only approve this if you started the sign-in yourself and the code matches your device.</p>${linkNotice}
<dl>
<dt>Code</dt><dd id="device-user-code" data-user-code="${escapeHtml(userCode)}" data-code-source="${source}">${escapeHtml(userCode)}</dd>
<dt>Application</dt><dd>${escapeHtml(clientName)}</dd>
<dt>Requested</dt><dd>${escapeHtml(device.createdAt.toISOString())}</dd>
<dt>From</dt><dd>${escapeHtml(place === '' ? 'unknown location' : place)}</dd>
<dt>Device</dt><dd>${escapeHtml(device.userAgent ?? 'unknown')}</dd>
<dt>Access</dt><dd><ul>${scopes}</ul></dd>
</dl>
<button type="button" id="device-approve">Approve</button>
<button type="button" id="device-deny">Deny</button>`
  );
}

/** A device page that only tells the user something, such as too many wrong codes. */
export function deviceMessagePage(message: string, status: number): Response {
  return page('Sign in on a device', 'device-message', `<p>${escapeHtml(message)}</p>`, status);
}

/**
 * The confirm page of an app that receives its code on a private-use URI scheme: the form posts
 * the same authorization URL back from this origin, which the hand-off approves and redirects to
 * `redirectUri`, so the page's `form-action` allows that URI's scheme.
 */
export function confirmAppPage(appName: string, redirectUri: string): Response {
  const response = page(
    'Continue to the app',
    'confirm-app',
    `<p>Open ${escapeHtml(appName)} signed in as you? Only continue if you started this sign-in in the app yourself.</p>
<form method="post">
<button type="submit" id="confirm-app">Continue</button>
</form>`
  );
  response.headers.set(
    'Content-Security-Policy',
    contentSecurityPolicy(`'self' ${new URL(redirectUri).protocol}`)
  );
  return response;
}

/** A page whose store call failed: 503 with `Retry-After` when a retry can succeed, else 500. */
export function unavailablePage(retryable: boolean): Response {
  const response = page(
    'Kilo sign-in',
    'unavailable',
    '<p>Sign-in is not available right now. Try again in a moment.</p>',
    retryable ? 503 : 500
  );
  if (retryable) response.headers.set('Retry-After', '2');
  return response;
}
