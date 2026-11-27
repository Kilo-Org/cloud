import { UTS_ENDPOINTS } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import type { UtsConfig } from '../../src/env';
import { signInEmailText } from '../../src/signin/email/delivery';
import { readSignInConfig, recipientAllowed } from '../../src/signin/providers/config';

/** The recipient rule, the sender check and the sign-in email text, without any network call. */

const config: UtsConfig = {
  environment: 'staging',
  endpoints: UTS_ENDPOINTS.staging,
  jurisdiction: 'eu',
  relyingParty: { rpId: 'staging-app.kilo.ai', origins: ['https://uts-staging.kiloapps.io'] },
  managerBaseUrl: null,
};

const vars = {
  UTS_MAILGUN_SENDING_KEY: 'synthetic-key',
  UTS_MAILGUN_DOMAIN: 'mail.example.com',
  UTS_MAIL_FROM: 'security@mail.example.com',
  UTS_TURNSTILE_SITE_KEY: 'site-key',
  UTS_TURNSTILE_SECRET_KEY: 'synthetic-secret',
};

function rule(allowList: string) {
  const mail = readSignInConfig({ ...vars, UTS_MAIL_ALLOWED_RECIPIENTS: allowList }, config).mail;
  if (mail.status !== 'on') throw new Error(`mail settings ${mail.status}`);
  return mail.recipients;
}

describe('recipient rule', () => {
  it('allows exact addresses and whole domains, case-insensitively, and nothing else', () => {
    const allowed = rule(' @Example.com ,tester@example.org');
    for (const address of ['a@example.com', 'A@EXAMPLE.COM', 'tester@example.org']) {
      expect(recipientAllowed(allowed, address)).toBe(true);
    }
    for (const address of ['a@sub.example.com', 'other@example.org', 'a@example.com.evil.test']) {
      expect(recipientAllowed(allowed, address)).toBe(false);
    }
  });

  it.each(['example.com', '@', 'a@b', '@example.com,,', 'a b@example.com'])(
    'refuses the allow-list %j',
    allowList => {
      expect(
        readSignInConfig({ ...vars, UTS_MAIL_ALLOWED_RECIPIENTS: allowList }, config).mail
      ).toEqual({ status: 'misconfigured', missing: ['UTS_MAIL_ALLOWED_RECIPIENTS'] });
    }
  );

  it('allows any address in production', () => {
    expect(recipientAllowed({ kind: 'any' }, 'person@gmail.com')).toBe(true);
  });
});

describe('sender', () => {
  it('takes a bare address or a display name on the sending domain', () => {
    for (const from of ['security@mail.example.com', "Kilo O'Brien <hi@mail.example.com>"]) {
      const mail = readSignInConfig(
        { ...vars, UTS_MAIL_FROM: from, UTS_MAIL_ALLOWED_RECIPIENTS: '@example.com' },
        config
      ).mail;
      expect(mail.status).toBe('on');
    }
  });
});

describe('sign-in email text', () => {
  const link = 'https://uts-staging.kiloapps.io/signin/email/link?token=T';
  const expiresAt = new Date('2026-11-27T09:05:00Z');

  it('names the link, the code and the expiry', () => {
    expect(signInEmailText({ to: 'a@example.com', link, code: '012345', expiresAt })).toBe(
      [
        'Open this link to sign in to Kilo:',
        '',
        link,
        '',
        'Or enter this code on the sign-in page: 012345',
        '',
        'The link and the code work for 10 minutes, until 09:05 UTC.',
        '',
        'If you did not ask to sign in, ignore this email. Do not forward it to anyone.',
      ].join('\n')
    );
  });

  it('names only the link while codes are stopped, and never the address', () => {
    const text = signInEmailText({ to: 'a@example.com', link, code: null, expiresAt });
    expect(text).toContain('The link works for 10 minutes, until 09:05 UTC.');
    expect(text).not.toContain('code');
    expect(text).not.toContain('a@example.com');
  });
});
