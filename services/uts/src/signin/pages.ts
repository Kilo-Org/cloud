import { UTS_DEVICE_VERIFICATION_PATH, UTS_SIGNIN_SCRIPT_PATH } from '@kilocode/uts-contracts';
import type { PendingDevice } from './store';

/**
 * The sign-in pages on the issuer origin (design 5.14). They are plain HTML with one same-origin
 * script (src/signin/script.ts), which runs the WebAuthn ceremonies and the device decision; no
 * inline script, no third-party resource, no framing. Every value a page shows is escaped.
 */

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ESCAPES[character] ?? character);
}

/** One page: `page` names what the script wires up (`data-page`). */
function page(title: string, pageName: string, body: string, status = 200): Response {
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

/** The sign-in page an interaction shows; after a sign-in the script reloads the same URL. */
export function signInPage(): Response {
  return page(
    'Sign in to Kilo',
    'sign-in',
    '<p>Use a passkey saved for your Kilo account.</p>\n<button type="button" id="passkey-sign-in">Sign in with a passkey</button>'
  );
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

/** The device page without a code, or after an unknown one: the user enters the code. */
export function deviceCodeEntryPage(message: string | null): Response {
  return page(
    'Sign in on a device',
    'device-entry',
    `${message === null ? '' : `<p>${escapeHtml(message)}</p>\n`}<form method="get" action="${UTS_DEVICE_VERIFICATION_PATH}">
<label for="user-code">Code shown on your device</label>
<input id="user-code" name="user_code" autocomplete="off" autocapitalize="characters" maxlength="16" required>
<button type="submit">Continue</button>
</form>`
  );
}

/** A device sign-in waiting for the user (RFC 8628 section 5.4): what asks, from where. */
export function deviceApprovalPage(
  userCode: string,
  clientName: string,
  device: PendingDevice
): Response {
  const place = [device.city, device.country].filter(part => part !== null).join(', ');
  const scopes = device.scopes.map(scope => `<li><code>${escapeHtml(scope)}</code></li>`).join('');
  return page(
    'Approve a device sign-in',
    'device-approval',
    `<p>Only approve this if you started the sign-in yourself and the code matches your device.</p>
<dl>
<dt>Code</dt><dd id="device-user-code" data-user-code="${escapeHtml(userCode)}">${escapeHtml(userCode)}</dd>
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
