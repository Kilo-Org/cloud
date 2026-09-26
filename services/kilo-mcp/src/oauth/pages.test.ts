import { describe, expect, it } from 'vitest';
import { PERSONAL_ORG_ID, consentPage, orgPickerPage } from './pages';
import { authenticatorUri } from '../otp/totp';

const WEB = 'https://app.kilo.test';
const ISSUER = 'https://kilo-mcp.test';
// The dropped approval queue lives nowhere on these pages any more.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const ENROLMENT_URI = authenticatorUri({ secret: SECRET, account: 'admin' });
/** The URI as the page renders it: escapeHtml turns `&` into `&amp;`. */
const ENROLMENT_URI_HTML = ENROLMENT_URI.replace(/&/g, '&amp;');

/** The checkbox tag alone, so a `checked` elsewhere in the page cannot match. */
function adminCheckboxTag(html: string): string {
  return html.match(/<input[^>]*name="admin_enabled"[^>]*>/)?.[0] ?? '';
}

describe('consentPage', () => {
  function render() {
    return consentPage({
      clientName: '<script>alert(1)</script>',
      scope: 'mcp',
      webSignInUrl: `${WEB}/device-auth?code=PAIR-1`,
      statusUrl: '/authorize/status?id=pa-1',
      restartUrl: `${ISSUER}/authorize?client_id=c`,
    });
  }

  it('escapes the client name and carries the status/restart/sign-in targets', async () => {
    const response = render();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    // No cache — browser or intermediary — may retain an OAuth flow page.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const html = await response.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Requested access');
    expect(html).toContain('Continue with Kilo sign-in');
    expect(html).toContain(`${WEB}/device-auth?code=PAIR-1`);
    expect(html).toContain('Start sign-in again');
    expect(html).toContain(`${ISSUER}/authorize?client_id=c`);
  });

  it('polls the status URL and turns every terminal answer into failure copy', async () => {
    const html = await render().text();
    // The status URL is injected into the polling script, not just the markup.
    expect(html).toContain('"/authorize/status?id=pa-1"');
    expect(html).toContain("j.status==='needs_org'");
    expect(html).toContain("j.status==='denied'");
    expect(html).toContain("j.status==='expired'");
    expect(html).toContain("j.status==='unknown'");
    expect(html).toContain('location.replace(j.picker_url)');
    // /authorize/org owns the post-consent client redirect; a status poll can
    // never answer 'approved', so the page carries no approved branch.
    expect(html).not.toContain("j.status==='approved'");
    expect(html).not.toContain('redirect_url');
  });

  it('keeps the restart CTA hidden until the poll fails and opens sign-in in a new tab', async () => {
    const html = await render().text();
    expect(html).toMatch(/id="restart"[^>]*\shidden/);
    // The [hidden] attribute must actually hide (author display rules win).
    expect(html).toContain('[hidden]{display:none !important}');
    expect(html).toMatch(/class="cta"[^>]*target="_blank"/);
    // The Kilo Cloud brand primary, not the old blue CTA.
    expect(html).toContain('--primary:#f7f586');
  });
});

describe('orgPickerPage', () => {
  it('renders one radio per option, checks the first, and escapes names', async () => {
    const response = orgPickerPage({
      clientName: 'Test <Client>',
      actionUrl: '/authorize/org?id=pa-1',
      options: [
        { id: PERSONAL_ORG_ID, name: 'Personal account' },
        { id: 'org-1', name: '<b>Acme</b>' },
      ],
      error: null,
      showAdminOption: false,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Choose a Kilo organization');
    expect(html).toContain('Test &lt;Client&gt;');
    expect(html).toContain(`value="${PERSONAL_ORG_ID}" checked`);
    expect(html).toContain('value="org-1"');
    expect(html).toContain('&lt;b&gt;Acme&lt;/b&gt;');
    expect(html).not.toContain('<b>Acme</b>');
    expect(html).toContain('action="/authorize/org?id=pa-1"');
    expect(html).toContain('Connect');
    // The admin opt-in lives only on an admin's page, the queue path nowhere.
    expect(html).not.toContain('admin_enabled');
    expect(html).not.toContain('queue');
  });

  it('renders an escaped alert for a rejected/served error when given one', async () => {
    const html = await orgPickerPage({
      clientName: 'c',
      actionUrl: '/authorize/org?id=pa-1',
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error: '<img src=x onerror=1>',
      showAdminOption: false,
    }).text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<img src=x onerror=1>');
  });

  it('renders the admin opt-in unchecked, with the authenticator notice and no queue', async () => {
    const html = await orgPickerPage({
      clientName: 'c',
      actionUrl: '/authorize/org?id=pa-1',
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error: null,
      showAdminOption: true,
      authenticator: { secret: SECRET, verified: false },
    }).text();
    expect(html).toContain('<input type="checkbox" name="admin_enabled" value="on">');
    expect(html).toContain('<span>Enable admin and debug actions</span>');
    expect(html).toContain(
      'Off by default. Admin and debug actions stay hidden until enabled, and each one needs a code from your authenticator app.'
    );
    expect(html).not.toContain('queue');
    // `checked` never appears: the opt-in is off until the admin ticks it.
    expect(adminCheckboxTag(html)).toBe('<input type="checkbox" name="admin_enabled" value="on">');
    // The shared `.org` row style carries the checkbox too.
    expect(html).toContain('.org input{accent-color:var(--primary);margin:0}');
    expect(html).toContain('.notice{color:var(--muted);font-size:13px}');
  });

  it('hides the authenticator subsection by default and reveals it with the checkbox', async () => {
    const html = await orgPickerPage({
      clientName: 'c',
      actionUrl: '/authorize/org?id=pa-1',
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error: null,
      showAdminOption: true,
      authenticator: { secret: SECRET, verified: false },
    }).text();
    expect(html).toContain('<div id="otp-section" hidden>');
    // The subsection sits after the org radios and before Connect.
    expect(html.indexOf('<div class="orgs">')).toBeLessThan(html.indexOf('name="admin_enabled"'));
    expect(html.indexOf('name="admin_enabled"')).toBeLessThan(html.indexOf('id="otp-section"'));
    expect(html.indexOf('id="otp-section"')).toBeLessThan(html.indexOf('>Connect<'));
    // The script flips `hidden` with the box and disables the code field while
    // hidden, and re-checks nothing else.
    expect(html).toContain("box.addEventListener('change'");
    expect(html).toContain('section.hidden=!box.checked');
    expect(html).toContain('code.disabled=!box.checked');
    expect(html).not.toContain('box.checked=true');
  });

  it('shows the secret, the otpauth URI and the code field for an unenrolled admin', async () => {
    const response = orgPickerPage({
      clientName: 'c',
      actionUrl: '/authorize/org?id=pa-1',
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error: null,
      showAdminOption: true,
      authenticator: { secret: SECRET, verified: false },
    });
    const html = await response.text();
    // The one-time TOTP secret is long-lived, so this response must not be
    // stored by any cache.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(html).toContain('Add an authenticator');
    expect(html).toContain(
      'Add this secret to your authenticator app, or enter the otpauth URI below:'
    );
    expect(html).toContain(`<code>${SECRET}</code>`);
    expect(html).toContain(`<code>${ENROLMENT_URI_HTML}</code>`);
    expect(html).toContain(
      '<label for="otp_code">Code from your authenticator app</label>' +
        '<input id="otp_code" name="otp_code" inputmode="numeric" autocomplete="one-time-code">'
    );
  });

  it('renders only a ticked checkbox for an enrolled admin', async () => {
    const html = await orgPickerPage({
      clientName: 'c',
      actionUrl: '/authorize/org?id=pa-1',
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error: null,
      showAdminOption: true,
      authenticator: { secret: SECRET, verified: true },
    }).text();
    // The tick is the only place the page shows the enrolled state; the label
    // and the notice stay.
    expect(adminCheckboxTag(html)).toBe(
      '<input type="checkbox" name="admin_enabled" value="on" checked>'
    );
    expect(html).toContain('<span>Enable admin and debug actions</span>');
    expect(html).toContain(
      'Off by default. Admin and debug actions stay hidden until enabled, and each one needs a code from your authenticator app.'
    );
    // Neither the enrolment material nor a code prompt: nothing but the box.
    expect(html).not.toContain('id="otp-section"');
    expect(html).not.toContain('otp_code');
    expect(html).not.toContain('Code from your authenticator app');
    expect(html).not.toContain('Add an authenticator');
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain('otpauth://');
    // No authenticator management surface exists anywhere on the page.
    for (const copy of ['manage', 're-enrol', 'reenrol', 'remove', 'disable', 'recovery']) {
      expect(html.toLowerCase()).not.toContain(copy);
    }
  });

  it('ignores the reveal flag once the authenticator is verified', async () => {
    const html = await orgPickerPage({
      clientName: 'c',
      actionUrl: '/authorize/org?id=pa-1',
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error: null,
      showAdminOption: true,
      authenticator: { secret: SECRET, verified: true },
      authenticatorRevealed: true,
    }).text();
    // The reveal flag only applies before verification.
    expect(adminCheckboxTag(html)).toBe(
      '<input type="checkbox" name="admin_enabled" value="on" checked>'
    );
    expect(html).not.toContain('id="otp-section"');
    expect(html).not.toContain('otp_code');
    expect(html).not.toContain('Code from your authenticator app');
  });

  it('renders the same ticked checkbox on every render, so the tick survives a reload', async () => {
    const input = {
      clientName: 'c',
      actionUrl: '/authorize/org?id=pa-1',
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error: null,
      showAdminOption: true,
      authenticator: { secret: SECRET, verified: true },
    };
    const first = await orgPickerPage(input).text();
    const second = await orgPickerPage(input).text();
    expect(second).toBe(first);
    expect(adminCheckboxTag(second)).toContain('checked');
  });

  it('reveals the subsection on a re-render after a refused submit', async () => {
    const html = await orgPickerPage({
      clientName: 'c',
      actionUrl: '/authorize/org?id=pa-1',
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error: 'Enter the code from your authenticator app.',
      showAdminOption: true,
      authenticator: { secret: SECRET, verified: false },
      authenticatorRevealed: true,
    }).text();
    expect(html).toContain('<div id="otp-section">');
    expect(html).not.toContain('<div id="otp-section" hidden>');
    expect(html).toContain('role="alert"');
  });

  it('renders no checkbox, notice or subsection for a non-admin', async () => {
    const html = await orgPickerPage({
      clientName: 'c',
      actionUrl: '/authorize/org?id=pa-1',
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error: null,
      showAdminOption: false,
      authenticator: null,
    }).text();
    expect(html).toContain('Personal account');
    expect(html).toContain('Connect');
    expect(html).not.toContain('admin_enabled');
    expect(html).not.toContain('Enable admin and debug actions');
    expect(html).not.toContain('Code from your authenticator app');
    expect(html).not.toContain('id="otp-section"');
    expect(html).not.toContain('class="notice"');
  });

  it('escapes the admin notice and renders none unless asked', async () => {
    const base = {
      clientName: 'c',
      actionUrl: '/authorize/org?id=pa-1',
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error: null,
      showAdminOption: false,
    };
    const quiet = await orgPickerPage({ ...base, adminNotice: null }).text();
    expect(quiet).not.toContain('class="notice"');

    const shown = await orgPickerPage({
      ...base,
      adminNotice: '<script>alert(1)</script>',
    }).text();
    expect(shown).toContain('<p class="notice">&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(shown).not.toContain('<script>alert(1)</script>');
  });
});
