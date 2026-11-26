/// <reference types="node" />
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { translatePush } from './i18n';
import { notificationHistoryEntryForPushData } from './notification-history';
import { accountSecurityPushCopy, genericPushContentForPushData } from './push-copy';
import { ACCOUNT_SECURITY_EVENTS, pushDataSchema } from './push-data';
import { pushBodyCatalogKey, pushTitleCatalogKey } from './push-i18n-keys';
import { androidChannelIdForPushData } from './push-presentation';
import { internalDispatchRequestSchema } from './rpc-schemas';

const request = {
  kind: 'account_security',
  recipientUserId: 'oauth/github/123',
  event: 'device_sign_in_approved',
  idempotencyKey: 'device_sign_in_approved:digest',
  origin: { actor: 'owner', device: 'Firefox on Linux', location: 'Lisbon, PT' },
};

const owner = (device: string | null, location: string | null) =>
  ({ actor: 'owner', device, location }) as const;

const selfNamed = (name: string) => ({ actor: 'self_named_device', name }) as const;

const SHIPPED_LOCALES = readdirSync(join(dirname(fileURLToPath(import.meta.url)), 'locales'))
  .filter(file => file.endsWith('.json') && file !== 'en.json')
  .map(file => file.slice(0, -'.json'.length));

describe('account-security dispatch request', () => {
  it('accepts an owner origin with or without a device and location, and a support origin', () => {
    expect(internalDispatchRequestSchema.parse(request)).toEqual(request);
    const bare = { ...request, origin: owner(null, null) };
    expect(internalDispatchRequestSchema.parse(bare)).toEqual(bare);
    const support = { ...request, event: 'sign_in_reset_by_support', origin: { actor: 'support' } };
    expect(internalDispatchRequestSchema.parse(support)).toEqual(support);
  });

  it('carries nothing about the request of a support action', () => {
    const parsed = internalDispatchRequestSchema.parse({
      ...request,
      origin: { actor: 'support', device: 'Chrome on macOS', location: 'Berlin, DE' },
    });
    expect(parsed).toMatchObject({ origin: { actor: 'support' } });
    expect(JSON.stringify(parsed)).not.toContain('Berlin');
  });

  it('rejects an event this build does not send', () => {
    expect(
      internalDispatchRequestSchema.safeParse({ ...request, event: 'password_changed' }).success
    ).toBe(false);
  });

  it('rejects an empty or oversized label and a missing idempotency key', () => {
    expect(
      internalDispatchRequestSchema.safeParse({ ...request, origin: owner('', null) }).success
    ).toBe(false);
    expect(
      internalDispatchRequestSchema.safeParse({ ...request, origin: owner(null, 'x'.repeat(121)) })
        .success
    ).toBe(false);
    expect(
      internalDispatchRequestSchema.safeParse({ ...request, idempotencyKey: '' }).success
    ).toBe(false);
  });

  it('accepts a self-named device origin only without a quote mark in its name', () => {
    const origin = selfNamed("Kilo CLI' verified by Kilo");
    expect(internalDispatchRequestSchema.parse({ ...request, origin })).toMatchObject({ origin });
    for (const name of ['Kilo CLI" verified by Kilo', 'Kilo “CLI”', '', 'x'.repeat(121)]) {
      expect(
        internalDispatchRequestSchema.safeParse({ ...request, origin: selfNamed(name) }).success,
        name
      ).toBe(false);
    }
  });
});

describe('account-security push', () => {
  it('carries only the event in its payload, on the security channel, with no history row', () => {
    const data = pushDataSchema.parse({ type: 'account_security', event: 'api_key_reset' });
    expect(data).toEqual({ type: 'account_security', event: 'api_key_reset' });
    expect(androidChannelIdForPushData(data)).toBe('security');
    expect(notificationHistoryEntryForPushData(data)).toBeNull();
  });

  it('shows a content-free banner in generic previews', () => {
    expect(
      genericPushContentForPushData({ type: 'account_security', event: 'new_sign_in' }, 'en')
    ).toEqual({ title: 'Kilo', body: 'There was security activity on your account' });
  });

  it('picks the body sentence for who acted and what the request carried', () => {
    const bodies = [
      accountSecurityPushCopy({ event: 'new_sign_in', origin: owner('Safari on iOS', 'Oslo, NO') }),
      accountSecurityPushCopy({ event: 'new_sign_in', origin: owner('Safari on iOS', null) }),
      accountSecurityPushCopy({ event: 'new_sign_in', origin: owner(null, 'Oslo, NO') }),
      accountSecurityPushCopy({ event: 'new_sign_in', origin: owner(null, null) }),
      accountSecurityPushCopy({ event: 'api_key_reset', origin: { actor: 'support' } }),
      accountSecurityPushCopy({
        event: 'device_sign_in_approved',
        origin: selfNamed('Kilo security check'),
      }),
    ].map(copy => copy.body);

    expect(bodies).toEqual([
      'From Safari on iOS near Oslo, NO. Not you? Review your account security now.',
      'From Safari on iOS. Not you? Review your account security now.',
      'Near Oslo, NO. Not you? Review your account security now.',
      'Not you? Review your account security now.',
      'Done by Kilo support. If you did not ask for this, contact support.',
      'From a device that named itself "Kilo security check". Not you? Review your account security now.',
    ]);
  });

  it('titles a support reset and an API token reset in the web app’s words', () => {
    expect(
      accountSecurityPushCopy({ event: 'sign_in_reset_by_support', origin: { actor: 'support' } })
    ).toEqual({
      title: 'Sign-in reset by Kilo support',
      body: 'Done by Kilo support. If you did not ask for this, contact support.',
      i18nKey: 'accountSecurity:sign_in_reset_by_support:support',
      i18nParams: {},
    });
    expect(
      accountSecurityPushCopy({ event: 'api_key_reset', origin: owner(null, null) }).title
    ).toBe('API token reset');
  });

  it('renders its own translated title and body for every event in every shipped locale', () => {
    expect(SHIPPED_LOCALES.length).toBeGreaterThan(80);
    for (const event of ACCOUNT_SECURITY_EVENTS) {
      for (const origin of [
        owner('Edge on Windows', 'Rome, IT'),
        selfNamed('Edge Helper'),
        { actor: 'support' } as const,
      ]) {
        const copy = accountSecurityPushCopy({ event, origin });
        const titleKey = pushTitleCatalogKey(copy.i18nKey);
        const bodyKey = pushBodyCatalogKey(copy.i18nKey);
        expect(translatePush('en', titleKey, copy.i18nParams, '')).toBe(copy.title);
        expect(translatePush('en', bodyKey, copy.i18nParams, '')).toBe(copy.body);
        for (const locale of SHIPPED_LOCALES) {
          const title = translatePush(locale, titleKey, copy.i18nParams, '');
          const body = translatePush(locale, bodyKey, copy.i18nParams, '');
          expect(title, `${locale} ${event} title`).not.toBe(copy.title);
          expect(body, `${locale} ${event} ${origin.actor} body`).not.toBe(copy.body);
          if (origin.actor === 'owner') {
            expect(body, `${locale} ${event} body`).toContain('Edge on Windows');
            expect(body, `${locale} ${event} body`).toContain('Rome, IT');
          }
          if (origin.actor === 'self_named_device') {
            expect(body, `${locale} ${event} self-named body`).toContain('Edge Helper');
          }
        }
      }
    }
  });
});
