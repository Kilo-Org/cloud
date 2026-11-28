import {
  UTS_APPS_PAGE_PATH,
  UTS_DEVICE_VERIFICATION_PATH,
  UTS_EMAIL_START_PATH,
  UTS_SIGNIN_SCRIPT_PATH,
  UTS_SSO_START_PATH,
  type UtsOAuthProvider,
  utsProviderStartPath,
} from '@kilocode/uts-contracts';
import { TURNSTILE_ACTION, TURNSTILE_RESPONSE_FIELD } from './email/turnstile';
import type { PendingDevice, UserCodeSource } from './store';

/**
 * The sign-in pages on the issuer origin (design 5.14). They are plain HTML with one same-origin
 * script (src/signin/script.ts), which runs the WebAuthn ceremonies and the device decision; no
 * inline script and no framing of the pages. The one third-party resource is Cloudflare
 * Turnstile's widget on a sign-in page that offers the email sign-in through Mailgun (design 5.3).
 * Every value a page shows is escaped.
 */

/** Turnstile's script; Cloudflare requires this exact URL, never a proxied or cached copy. */
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`;

/**
 * `form-action` also governs where a form submission redirects, so a page whose form ends in an
 * app's redirect names that URI's scheme beside `'self'`. A sign-in page whose form returns to an
 * authorization request that ends on a client's registered callback names only that callback's
 * origin (`clientReturnOrigin`, src/signin/form-action.ts); without one it names `'self'` alone.
 *
 * A page that runs a passkey ceremony also names `https://<rpId>/.well-known/webauthn` in
 * `connect-src`. In production the relying-party id is the app host, not the page's host, so the
 * browser fetches that URL itself to check that the page's origin is a related origin (WebAuthn
 * Level 3, section 5.11.1). The specification does not say whether the page's policy governs that
 * fetch (w3c/webauthn issue 2408). Chromium checks the URL and every redirect against the page's
 * enforced `connect-src` (components/webauthn/core/browser/remote_validation.cc) and today only
 * counts a refusal; a page that names the URL keeps working when a browser enforces the check. In
 * staging and development the relying-party id is the page's own host, the browser fetches
 * nothing, and the entry is inert.
 *
 * A page with the Turnstile widget adds `https://challenges.cloudflare.com` to `script-src` and
 * `frame-src`, the two directives Cloudflare documents for the widget's script and frame.
 *
 * No `Permissions-Policy` is needed: the default allowlist of `publickey-credentials-get` and
 * `publickey-credentials-create` is `'self'`, which allows a top-level page. The allowlist names
 * the origins of frames, not relying parties, and the pages refuse every frame.
 */
function contentSecurityPolicy(formAction: string, rpId: string | null, turnstile = false): string {
  const connect = rpId === null ? "'self'" : `'self' https://${rpId}/.well-known/webauthn`;
  const script = turnstile ? `'self' ${TURNSTILE_ORIGIN}` : "'self'";
  const frame = turnstile ? ` frame-src ${TURNSTILE_ORIGIN};` : '';
  return `default-src 'none'; script-src ${script};${frame} connect-src ${connect}; img-src 'self'; style-src 'self'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`;
}

function securityHeaders(rpId: string | null, turnstile: boolean, clientOrigin: string | null) {
  const formAction = clientOrigin === null ? "'self'" : `'self' ${clientOrigin}`;
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': contentSecurityPolicy(formAction, rpId, turnstile),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // No referrer leaves for another origin. `no-referrer` would also make a browser send
    // `Origin: null` with the pages' own form posts, which `isSameOriginPost` then refuses.
    'Referrer-Policy': 'same-origin',
  };
}

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

/**
 * What a page that runs a passkey ceremony adds: the relying-party id, for its `connect-src` and
 * for the script, and the notice the script shows in place of every `data-passkey` element when
 * the browser cannot use the relying party's passkeys on this origin (design 5.14).
 */
type PasskeyUse = { rpId: string; unavailable: string };

function render(
  title: string,
  pageName: string,
  body: string,
  status: number,
  passkey: PasskeyUse | null,
  turnstile = false,
  /** The client origin of `clientReturnOrigin`, which `form-action` names beside `'self'`. */
  clientOrigin: string | null = null
): Response {
  const rpId = passkey === null ? '' : ` data-rp-id="${escapeHtml(passkey.rpId)}"`;
  const notice =
    passkey === null
      ? ''
      : `<p id="passkey-unavailable" role="alert" hidden>${escapeHtml(passkey.unavailable)}</p>\n`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="${UTS_SIGNIN_SCRIPT_PATH}" defer></script>
${turnstile ? `<script src="${TURNSTILE_SCRIPT}" async defer></script>\n` : ''}</head>
<body data-page="${escapeHtml(pageName)}"${rpId}>
<main>
<h1>${escapeHtml(title)}</h1>
${notice}${body}
<p id="status" role="status" aria-live="polite"></p>
<noscript><p>Sign-in needs JavaScript and a browser with passkey support.</p></noscript>
</main>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: securityHeaders(passkey?.rpId ?? null, turnstile, clientOrigin),
  });
}

/**
 * One page: `page` names what the script wires up (`data-page`). A page whose form returns to an
 * authorization request passes the request's `clientReturnOrigin` (src/signin/form-action.ts).
 */
export function page(
  title: string,
  pageName: string,
  body: string,
  status = 200,
  clientOrigin: string | null = null
): Response {
  return render(title, pageName, body, status, null, false, clientOrigin);
}

/** The sign-in methods the page offers besides the passkey (`signInChoices`, src/signin/flows.ts). */
export type SignInChoices = {
  /** The path the sign-in returns to: the authorization URL that showed the page, or another. */
  returnTo: string;
  /**
   * The registered client origin the authorization request in `returnTo` redirects to, which the
   * page's `form-action` names beside `'self'` (`clientReturnOrigin`), or null.
   */
  clientOrigin: string | null;
  /** The relying-party id of the passkey sign-in (`WEBAUTHN_RP_ID`). */
  rpId: string;
  providers: readonly { provider: UtsOAuthProvider; name: string }[];
  /**
   * The email sign-in, or null when it is not offered. `turnstileSiteKey` puts Cloudflare's
   * Turnstile widget in the form; it is null only for the development entry's recording port.
   */
  email: { turnstileSiteKey: string | null } | null;
  /** Whether the page offers SSO, which starts with the user's work address. */
  sso: boolean;
};

/**
 * The sign-in page an interaction shows. After a passkey sign-in the script reloads the same URL;
 * a provider, SSO or email sign-in returns to `returnTo`. A browser that cannot use the relying
 * party's passkeys here sees the other methods only (design 5.14).
 */
export function signInPage(choices: SignInChoices): Response {
  const returnTo = escapeHtml(choices.returnTo);
  const returnQuery = escapeHtml(new URLSearchParams({ return_to: choices.returnTo }).toString());
  const parts = [
    '<div data-passkey>\n<p>Use a passkey saved for your Kilo account.</p>\n<button type="button" id="passkey-sign-in">Sign in with a passkey</button>\n</div>',
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
  if (choices.email !== null) {
    const siteKey = choices.email.turnstileSiteKey;
    const widget =
      siteKey === null
        ? ''
        : `<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${TURNSTILE_ACTION}" data-response-field-name="${TURNSTILE_RESPONSE_FIELD}"></div>\n`;
    parts.push(`<form method="post" action="${UTS_EMAIL_START_PATH}">
<input type="hidden" name="return_to" value="${returnTo}">
<label for="email-address">Email address</label>
<input id="email-address" name="email" type="email" autocomplete="email" maxlength="320" required>
${widget}<button type="submit">Email me a sign-in link and code</button>
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
  const otherMethods = choices.providers.length > 0 || choices.email !== null || choices.sso;
  return render(
    'Sign in to Kilo',
    'sign-in',
    parts.join('\n'),
    200,
    {
      rpId: choices.rpId,
      unavailable: otherMethods
        ? 'This browser cannot use a Kilo passkey on this page. Sign in another way below.'
        : 'This browser cannot use a Kilo passkey on this page. Update the browser or use another one.',
    },
    choices.email !== null && choices.email.turnstileSiteKey !== null,
    choices.clientOrigin
  );
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

/**
 * The page where a signed-in user adds a passkey (a tier A action, design 5.11). A browser that
 * cannot use the relying party's passkeys here cannot add one either: the page says so and asks
 * for no challenge (design 5.14).
 */
export function passkeysPage(rpId: string): Response {
  return render(
    'Add a passkey',
    'passkeys',
    `<p>A passkey lets you sign in without a password.</p>
<div data-passkey>
<label for="passkey-name">Passkey name</label>
<input id="passkey-name" name="name" maxlength="100" autocomplete="off" required>
<button type="button" id="passkey-register">Add a passkey</button>
</div>`,
    200,
    {
      rpId,
      unavailable:
        'This browser cannot add a passkey for your Kilo account on this page. Update the browser or use another one to add a passkey. Your other sign-in methods keep working.',
    }
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
 * tells a user without a passkey to type the code on the plain device page instead, and a browser
 * that cannot use the relying party's passkeys here does not offer to approve it (design 5.14).
 * A typed code needs a passkey check only when the sign-in is older than 10 minutes.
 */
export function deviceApprovalPage(
  userCode: string,
  source: UserCodeSource,
  clientName: string,
  device: PendingDevice,
  rpId: string
): Response {
  const place = [device.city, device.country].filter(part => part !== null).join(', ');
  const scopes = device.scopes.map(scope => `<li><code>${escapeHtml(scope)}</code></li>`).join('');
  const linkNotice =
    source === 'link'
      ? `\n<p>This code came in a link, so approving asks for your passkey. No passkey? <a id="type-code" href="${UTS_DEVICE_VERIFICATION_PATH}">Type the code from your device</a> instead.</p>`
      : '';
  const approve = `<button type="button" id="device-approve"${source === 'link' ? ' data-passkey' : ''}>Approve</button>`;
  return render(
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
${approve}
<button type="button" id="device-deny">Deny</button>`,
    200,
    {
      rpId,
      unavailable:
        source === 'link'
          ? 'This browser cannot use your passkey on this page, so it cannot approve a code that came in a link. Type the code from your device instead.'
          : 'This browser cannot use your passkey on this page, and a typed code needs one when you signed in more than 10 minutes ago. Sign in again in a private window, then type the code from your device.',
    }
  );
}

/** A device page that only tells the user something, such as too many wrong codes. */
export function deviceMessagePage(message: string, status: number): Response {
  return page('Sign in on a device', 'device-message', `<p>${escapeHtml(message)}</p>`, status);
}

/**
 * The confirm page of a native app, which receives its code on a loopback address or a
 * private-use URI scheme (RFC 8252 section 8.6): the form posts the same authorization URL back
 * from this origin, which the hand-off approves and redirects to `redirectUri`, so the page's
 * `form-action` allows that redirect's origin (loopback) or scheme (private use).
 */
export function confirmAppPage(appName: string, redirectUri: string): Response {
  const response = page(
    'Continue to the app',
    'confirm-app',
    `<p>Open ${escapeHtml(appName)} signed in as you? Only continue if you started this sign-in in the app yourself.</p>
<p>The app receives the sign-in at <code>${escapeHtml(redirectUri)}</code>.</p>
<form method="post">
<button type="submit" id="confirm-app">Continue</button>
</form>`
  );
  response.headers.set(
    'Content-Security-Policy',
    contentSecurityPolicy(formActionFor(redirectUri), null)
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

/**
 * Where a form whose answer redirects to `redirectUri` may go: this origin and that URI's origin,
 * or its scheme for a private-use scheme. Browsers apply `form-action` to every redirect of a form
 * submission, so the consent form needs the client's redirect target too.
 */
function formActionFor(redirectUri: string): string {
  const url = new URL(redirectUri);
  const target = url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : url.protocol;
  return `'self' ${target}`;
}

/** What the consent screen shows (design 5.9): the client, its metadata URL, the access, the org. */
export type ConsentView = {
  clientName: string;
  /** The client id: the URL of its Client ID Metadata Document. */
  clientId: string;
  /** One line per requested scope, in the order of `scopes`: the registry's consent text. */
  lines: readonly { scope: string; text: string }[];
  orgId: string | null;
  redirectUri: string;
  rpId: string;
  /**
   * `ask`: the first view. `untick`: the form came back without every box ticked. `gate`: the
   * session's sign-in is older than 10 minutes, so allowing needs a passkey check first.
   */
  state: 'ask' | 'untick' | 'gate';
};

/**
 * The consent screen of a third-party client. The form posts the same authorization URL back from
 * this origin with one ticked box per line; allowing writes the consent and redirects to the
 * client with the code, denying redirects with `access_denied`. A tier B check stands before the
 * consent (design 5.11): when the sign-in is older than 10 minutes, the Allow button first runs a
 * passkey step-up (`data-step-up`, src/signin/script.ts) and then submits.
 */
export function consentPage(view: ConsentView): Response {
  const notices = {
    ask: '',
    untick: '<p role="alert">Tick each box to allow this access, or deny it.</p>\n',
    gate: '<p role="alert">You signed in more than 10 minutes ago. Confirm with your passkey to allow this app.</p>\n',
  } as const;
  const org =
    view.orgId === null
      ? ''
      : `\n<dt>Organization</dt><dd><code>${escapeHtml(view.orgId)}</code></dd>`;
  const boxes = view.lines
    .map(
      (line, index) =>
        `<p><input type="checkbox" id="consent-${index}" name="consent" value="${escapeHtml(line.scope)}" required> <label for="consent-${index}">${escapeHtml(line.text)}</label></p>`
    )
    .join('\n');
  const stepUp = view.state === 'gate' ? ' data-step-up data-passkey' : '';
  const response = render(
    `Allow ${view.clientName}?`,
    'consent',
    `${notices[view.state]}<p><strong>${escapeHtml(view.clientName)}</strong> asks for access to your Kilo account. Only allow apps you trust.</p>
<dl>
<dt>App</dt><dd>${escapeHtml(view.clientName)}</dd>
<dt>Registered at</dt><dd><code>${escapeHtml(view.clientId)}</code></dd>${org}
<dt>Returns to</dt><dd><code>${escapeHtml(view.redirectUri)}</code></dd>
</dl>
<form method="post" id="consent-form">
${boxes}
<button type="submit" name="decision" value="allow" id="consent-allow"${stepUp}>Allow</button>
<button type="submit" name="decision" value="deny" id="consent-deny" formnovalidate>Deny</button>
</form>`,
    view.state === 'ask' ? 200 : view.state === 'untick' ? 400 : 403,
    {
      rpId: view.rpId,
      unavailable:
        'This browser cannot use your passkey on this page, and allowing an app needs one when you signed in more than 10 minutes ago. Sign in again in a private window, then allow the app.',
    }
  );
  response.headers.set(
    'Content-Security-Policy',
    contentSecurityPolicy(formActionFor(view.redirectUri), view.rpId)
  );
  return response;
}

/** One app on the apps page. */
export type AppListing = {
  consentId: string;
  clientName: string;
  clientId: string;
  lines: readonly string[];
  orgId: string | null;
  grantedAt: Date;
};

/**
 * The apps page (design 5.9): every third-party app that holds a consent of the signed-in account,
 * each with a Withdraw button. Withdrawing posts the consent id to the same path from this origin.
 */
export function appsPage(
  apps: readonly AppListing[],
  message: string | null,
  status = 200
): Response {
  const notice = message === null ? '' : `<p role="status">${escapeHtml(message)}</p>\n`;
  const items = apps
    .map(app => {
      const org =
        app.orgId === null ? '' : ` for organization <code>${escapeHtml(app.orgId)}</code>`;
      const lines = app.lines.map(line => `<li>${escapeHtml(line)}</li>`).join('');
      return `<li>
<p><strong>${escapeHtml(app.clientName)}</strong>${org}, allowed ${escapeHtml(app.grantedAt.toISOString())}</p>
<p><code>${escapeHtml(app.clientId)}</code></p>
<ul>${lines}</ul>
<form method="post" action="${UTS_APPS_PAGE_PATH}">
<input type="hidden" name="consent_id" value="${escapeHtml(app.consentId)}">
<button type="submit">Withdraw access</button>
</form>
</li>`;
    })
    .join('\n');
  const body =
    apps.length === 0
      ? '<p>No app has access to your Kilo account.</p>'
      : `<p>These apps can act for you within the access you allowed. Withdrawing ends their access within a minute.</p>
<ul>
${items}
</ul>`;
  return page('Apps with access', 'apps', `${notice}${body}`, status);
}
