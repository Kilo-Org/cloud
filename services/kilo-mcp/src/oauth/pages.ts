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

/** A selectable organization; `id` is the value posted back to the worker. */
export type OrgOption = { id: string; name: string };

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
  '.err{color:var(--danger)}';

/** The picker HTML: one radio per selectable context + a Connect button. */
export function orgPickerPage(input: {
  clientName: string;
  actionUrl: string;
  options: OrgOption[];
  error: string | null;
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
  const body =
    `<h1>Choose a Kilo organization</h1>` +
    `<p><strong>${escapeHtml(input.clientName)}</strong> is connecting to Kilo MCP. ` +
    `Pick the account to use.</p>` +
    errorHtml +
    `<form method="post" action="${escapeHtml(input.actionUrl)}">` +
    `<div class="orgs">${optionsHtml}</div>` +
    `<button class="cta" type="submit">Connect</button>` +
    `</form>`;
  const page = authPage('Choose a Kilo organization', body);
  // The picker needs radio-list layout the shared shell does not carry.
  return htmlResponse(page.replace('</head>', `<style>${PICKER_STYLE}</style></head>`));
}
