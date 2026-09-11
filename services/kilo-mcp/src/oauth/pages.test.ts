import { describe, expect, it } from 'vitest';
import { PERSONAL_ORG_ID, consentPage, orgPickerPage } from './pages';

const WEB = 'https://app.kilo.test';
const ISSUER = 'https://kilo-mcp.test';

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
  });

  it('renders an escaped alert for a rejected/served error when given one', async () => {
    const html = await orgPickerPage({
      clientName: 'c',
      actionUrl: '/authorize/org?id=pa-1',
      options: [{ id: PERSONAL_ORG_ID, name: 'Personal account' }],
      error: '<img src=x onerror=1>',
    }).text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<img src=x onerror=1>');
  });
});
