import { describe, expect, it } from 'vitest';
import {
  confirmAppPage,
  deviceApprovalPage,
  deviceCodeEntryPage,
  messagePage,
  passkeysPage,
  signInPage,
  type SignInChoices,
} from '../../src/signin/pages';
import type { PendingDevice } from '../../src/signin/store';

const RP_ID = 'app.kilo.ai';
const PASSKEY_CONNECT = "connect-src 'self' https://app.kilo.ai/.well-known/webauthn;";

const device: PendingDevice = {
  clientId: 'kilo-cli',
  scopes: ['gateway:models.read'],
  createdAt: new Date('2026-11-26T10:00:00Z'),
  expiresAt: new Date('2026-11-26T10:10:00Z'),
  userAgent: null,
  country: null,
  city: null,
};

const RECORDING_EMAIL = { turnstileSiteKey: null };

function choices(methods: { email: SignInChoices['email'] }): SignInChoices {
  return { returnTo: '/signin/done', rpId: RP_ID, providers: [], email: methods.email, sso: false };
}

describe('sign-in page policy', () => {
  it('lets the passkey pages reach the relying party well-known URL, and nothing else on its host', () => {
    for (const response of [
      signInPage(choices({ email: RECORDING_EMAIL })),
      passkeysPage(RP_ID),
      deviceApprovalPage('ABCD-EFGH', 'link', 'Kilo', device, RP_ID),
      deviceApprovalPage('ABCD-EFGH', 'typed', 'Kilo', device, RP_ID),
    ]) {
      const policy = response.headers.get('Content-Security-Policy');
      expect(policy).toContain(PASSKEY_CONNECT);
      expect(policy).toContain("default-src 'none'; script-src 'self';");
      expect(policy).toContain("form-action 'self';");
      expect(response.headers.get('Permissions-Policy')).toBeNull();
    }
  });

  it('keeps connect-src to the issuer on pages that run no passkey ceremony', () => {
    for (const response of [
      deviceCodeEntryPage(null, null),
      messagePage('Signed in', 'You are signed in.', 200, null),
      confirmAppPage('Kilo', 'com.kilocode.kiloapp:/oauth/callback'),
    ]) {
      expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self';");
    }
  });

  it('gives the confirm page its app scheme in form-action and no relying-party entry', () => {
    const policy = confirmAppPage('Kilo', 'com.kilocode.kiloapp:/oauth/callback').headers.get(
      'Content-Security-Policy'
    );
    expect(policy).toContain("form-action 'self' com.kilocode.kiloapp:;");
    expect(policy).not.toContain('well-known');
  });

  it('lets Cloudflare Turnstile run only on a sign-in page whose email form carries the widget', async () => {
    const response = signInPage(choices({ email: { turnstileSiteKey: '0x4AAAAAAA-test_key' } }));
    const policy = response.headers.get('Content-Security-Policy');
    expect(policy).toContain(
      "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com;"
    );
    const html = await response.text();
    expect(html).toContain(
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    );
    expect(html).toContain(
      '<div class="cf-turnstile" data-sitekey="0x4AAAAAAA-test_key" data-action="email-sign-in" data-response-field-name="cf-turnstile-response"></div>'
    );
    for (const page of [
      signInPage(choices({ email: RECORDING_EMAIL })),
      signInPage(choices({ email: null })),
    ]) {
      expect(page.headers.get('Content-Security-Policy')).not.toContain(
        'challenges.cloudflare.com'
      );
      expect(await page.text()).not.toContain('cf-turnstile');
    }
  });
});

describe('passkey fallback markup', () => {
  it('names the relying party for the script and keeps the unavailable notice hidden', async () => {
    const html = await signInPage(choices({ email: RECORDING_EMAIL })).text();
    expect(html).toContain('<body data-page="sign-in" data-rp-id="app.kilo.ai">');
    expect(html).toContain(
      '<p id="passkey-unavailable" role="alert" hidden>This browser cannot use a Kilo passkey on this page. Sign in another way below.</p>'
    );
    expect(html).toContain('<div data-passkey>');
  });

  it('tells a sign-in page without other methods to change the browser', async () => {
    const html = await signInPage(choices({ email: null })).text();
    expect(html).toContain('Update the browser or use another one.</p>');
  });

  it('marks the passkey-only controls of the add and approve pages', async () => {
    const passkeys = await passkeysPage(RP_ID).text();
    expect(passkeys).toContain('This browser cannot add a passkey for your Kilo account');
    expect(passkeys).toMatch(/<div data-passkey>\n<label for="passkey-name">/);
    const link = await deviceApprovalPage('ABCD-EFGH', 'link', 'Kilo', device, RP_ID).text();
    expect(link).toContain(
      '<button type="button" id="device-approve" data-passkey>Approve</button>'
    );
    expect(link).toContain('cannot approve a code that came in a link');
    const typed = await deviceApprovalPage('ABCD-EFGH', 'typed', 'Kilo', device, RP_ID).text();
    expect(typed).toContain('<button type="button" id="device-approve">Approve</button>');
    expect(typed).toContain('more than 10 minutes ago');
  });

  it('adds no relying party or notice to other pages', async () => {
    const html = await deviceCodeEntryPage(null, null).text();
    expect(html).not.toContain('data-rp-id');
    expect(html).not.toContain('passkey-unavailable');
  });
});
