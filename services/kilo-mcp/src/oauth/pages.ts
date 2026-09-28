/**
 * Render helpers for the library-backed OAuth flow (s3): the consent page
 * served at GET /authorize and the organization picker served at
 * GET|POST /authorize/org.
 *
 * These pages live beside the defaultHandler (src/oauth/consent.ts) that owns
 * them; the markup, the Kilo Cloud palette, and the status-polling script are
 * unchanged. Only the shared shell (authPage/escapeHtml/htmlResponse) is
 * reused from src/auth/http.ts.
 */
import { authPage, escapeHtml, htmlResponse, PAIRING_POLL_INTERVAL_MS } from '../auth/http';
import { authenticatorUri } from '../otp/totp';

/** A selectable organization; `id` is the value posted back to the worker. */
export type OrgOption = { id: string; name: string };

/**
 * The admin's authenticator as the opt-in row renders it: the stored secret
 * (shown only by the enrolment subsection, before a code ever verifies) and
 * whether a code has already verified against it. The verified state is the
 * checkbox's tick and nothing else.
 */
export type AuthenticatorView = { secret: string; verified: boolean };

/**
 * The account label the `otpauth://` URI carries (`Kilo:MCP-<account>`). The
 * picker has no email to hand and the admin is the only person who ever sees
 * this URI, so one stable label is enough to tell the entry apart in an
 * authenticator app.
 */
const AUTHENTICATOR_ACCOUNT = 'admin';

/** The personal (org-less) context: always available for a Kilo login. */
export const PERSONAL_ORG_ID = 'personal';

/**
 * The consent HTML: sign-in link + status polling until the flow resolves.
 *
 * The sign-in link opens in a NEW TAB on purpose: the pairing-status poll runs
 * in this tab, so sending the user to apps/web in the same tab killed the poll
 * (the page had to be reopened from the MCP client). A background tab keeps
 * polling; the browser may throttle it while hidden, and it catches up when
 * this tab regains focus.
 */
export function consentPage(input: {
  clientName: string;
  scope: string;
  webSignInUrl: string;
  statusUrl: string;
  /** The original /authorize URL; the failure states offer to restart from it. */
  restartUrl: string;
}): Response {
  const body =
    `<h1>Connect to Kilo MCP</h1>` +
    `<p><strong>${escapeHtml(input.clientName)}</strong> is asking to connect to Kilo MCP ` +
    `with your Kilo account.</p>` +
    `<p>Requested access: <code>${escapeHtml(input.scope)}</code></p>` +
    `<a class="cta" href="${escapeHtml(input.webSignInUrl)}" target="_blank" ` +
    `rel="noopener noreferrer">Continue with Kilo sign-in</a>` +
    `<p id="status" role="status">Waiting for you to finish sign-in&hellip;</p>` +
    `<a id="restart" class="secondary" href="${escapeHtml(input.restartUrl)}" hidden>` +
    `Start sign-in again</a>` +
    `<script>(function(){var u=${JSON.stringify(input.statusUrl)};var el=document.getElementById('status');` +
    `var restart=document.getElementById('restart');` +
    `function fail(msg){el.textContent=msg;restart.hidden=false;}` +
    `async function poll(){try{var r=await fetch(u,{credentials:'omit'});var j=await r.json();` +
    `if(j.status==='needs_org'){location.replace(j.picker_url);return;}` +
    `if(j.status==='denied'){fail('Kilo sign-in was denied. Start sign-in again to retry, or close this tab.');return;}` +
    `if(j.status==='expired'){fail('The Kilo sign-in request expired. Start sign-in again to try once more.');return;}` +
    `if(j.status==='unknown'){fail('This request is no longer valid. Start sign-in again, or close this tab and retry from your MCP client.');return;}}` +
    `catch(e){}setTimeout(poll,${PAIRING_POLL_INTERVAL_MS});}poll();})();</script>`;
  return htmlResponse(authPage('Connect to Kilo MCP', body));
}

// The picker needs a radio-list layout the shared shell does not carry. Colors
// and the submit CTA come from the shell's Kilo Cloud palette (auth/http.ts).
const PICKER_STYLE =
  '.org{display:flex;align-items:center;gap:10px;padding:12px 14px;margin:8px 0;' +
  'border:1px solid var(--border);border-radius:10px;cursor:pointer;background:var(--input)}' +
  '.org:hover{border-color:var(--border-strong);background:var(--hover)}' +
  '.org input{accent-color:var(--primary);margin:0}' +
  '.err{color:var(--danger)}' +
  '.notice{color:var(--muted);font-size:13px}' +
  // The authenticator subsection sits between the opt-in row and Connect; it
  // keeps the layout below the org list, so revealing it shifts nothing above.
  '#otp-section{margin:8px 0;padding:12px 14px;border:1px solid var(--border);' +
  'border-radius:10px;background:var(--input)}' +
  '#otp-section h2{font-size:13px;font-weight:600;margin:0 0 8px;color:var(--foreground)}' +
  '#otp-section p{margin:0 0 8px;font-size:13px;color:var(--muted)}' +
  '#otp-section code{overflow-wrap:anywhere}' +
  '#otp-section label{display:block;margin:10px 0 4px;font-size:13px;color:var(--muted)}' +
  '#otp-section input{width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--border);' +
  'background:var(--background);color:var(--foreground);font-size:14px;letter-spacing:.12em;' +
  'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}';

/**
 * The enrolment subsection for an admin with no verified authenticator yet: the
 * one-time secret, its `otpauth://` URI and the code field. Hidden by default —
 * the inline script reveals it with the checkbox and disables the code field
 * while hidden, so a disabled input is never submitted. An already enrolled
 * admin gets no subsection at all: the ticked checkbox is the whole surface.
 */
function authenticatorSectionHtml(input: { secret: string; revealed: boolean }): string {
  return (
    `<div id="otp-section"${input.revealed ? '' : ' hidden'}>` +
    `<h2>Add an authenticator</h2>` +
    `<p>Add this secret to your authenticator app, or enter the otpauth URI below:</p>` +
    `<p><code>${escapeHtml(input.secret)}</code></p>` +
    `<p><code>${escapeHtml(
      authenticatorUri({
        secret: input.secret,
        account: AUTHENTICATOR_ACCOUNT,
      })
    )}</code></p>` +
    `<label for="otp_code">Code from your authenticator app</label>` +
    `<input id="otp_code" name="otp_code" inputmode="numeric" autocomplete="one-time-code">` +
    `</div>`
  );
}

/**
 * Flip the subsection with the checkbox. Binding only to `change` (no initial
 * sync) keeps a re-render that already revealed the subsection — after a
 * refused enrol submit — visible even though the box is never pre-checked
 * before verification. Nothing else is re-checked or resubmitted.
 */
const OTP_SECTION_SCRIPT =
  `<script>(function(){var box=document.querySelector('input[name="admin_enabled"]');` +
  `var section=document.getElementById('otp-section');` +
  `var code=document.getElementById('otp_code');` +
  `box.addEventListener('change',function(){section.hidden=!box.checked;` +
  `code.disabled=!box.checked;});})();</script>`;

/**
 * The picker HTML: one radio per selectable context, the admin opt-in row for
 * an admin identity, and a Connect button.
 */
export function orgPickerPage(input: {
  clientName: string;
  actionUrl: string;
  options: OrgOption[];
  error: string | null;
  /** Renders the admin opt-in row only when the paired identity is an admin. */
  showAdminOption: boolean;
  /**
   * The admin's authenticator for the opt-in row. Rendered only beside the
   * opt-in row: absent for a non-admin and for a failed admin check. Verified
   * renders the ticked checkbox alone; unverified adds the enrolment subsection.
   */
  authenticator?: AuthenticatorView | null;
  /**
   * Reveal the enrolment subsection on a re-render after a refused admin
   * submit, whose (never pre-checked) box would otherwise leave it collapsed.
   */
  authenticatorRevealed?: boolean;
  /** Fail-closed explanation shown when the admin check could not be reached. */
  adminNotice?: string | null;
}): Response {
  const optionsHtml = input.options
    .map(
      (option, index) =>
        `<label class="org"><input type="radio" name="organization_id" value="${escapeHtml(option.id)}"` +
        `${index === 0 ? ' checked' : ''}><span>${escapeHtml(option.name)}</span></label>`
    )
    .join('');
  const errorHtml = input.error
    ? `<p id="error" role="alert" class="err">${escapeHtml(input.error)}</p>`
    : '';
  // The checkbox's two states. Unchecked for an admin with no verified
  // authenticator: the opt-in is deliberate, and a re-render after a refused
  // enrol submit must not resubmit it pre-ticked. Ticked for an admin whose
  // authenticator is verified, because the checkbox is the only place the page
  // shows that enrolled state and the tick must survive every re-render and
  // reload. The subsection exists only before verification.
  const verifiedAuthenticator = input.authenticator?.verified === true;
  const otpSectionHtml =
    input.showAdminOption && input.authenticator && !verifiedAuthenticator
      ? authenticatorSectionHtml({
          secret: input.authenticator.secret,
          revealed: input.authenticatorRevealed === true,
        })
      : '';
  const adminHtml = input.showAdminOption
    ? `<label class="org"><input type="checkbox" name="admin_enabled" value="on"${verifiedAuthenticator ? ' checked' : ''}>` +
      `<span>Enable admin and debug actions</span></label>` +
      `<p class="notice">Off by default. Admin and debug actions stay hidden until enabled, and each one needs a code from your authenticator app.</p>` +
      otpSectionHtml +
      (otpSectionHtml ? OTP_SECTION_SCRIPT : '')
    : '';
  const noticeHtml = input.adminNotice
    ? `<p class="notice">${escapeHtml(input.adminNotice)}</p>`
    : '';
  const body =
    `<h1>Choose a Kilo organization</h1>` +
    `<p><strong>${escapeHtml(input.clientName)}</strong> is connecting to Kilo MCP. ` +
    `Pick the account to use.</p>` +
    errorHtml +
    `<form method="post" action="${escapeHtml(input.actionUrl)}">` +
    `<div class="orgs">${optionsHtml}</div>` +
    adminHtml +
    noticeHtml +
    `<button class="cta" type="submit">Connect</button>` +
    `</form>`;
  const page = authPage('Choose a Kilo organization', body);
  // The picker needs radio-list layout the shared shell does not carry.
  return htmlResponse(page.replace('</head>', `<style>${PICKER_STYLE}</style></head>`));
}
