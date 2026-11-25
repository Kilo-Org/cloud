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
  device: 'Firefox on Linux',
  location: 'Lisbon, PT',
};

const SHIPPED_LOCALES = readdirSync(join(dirname(fileURLToPath(import.meta.url)), 'locales'))
  .filter(file => file.endsWith('.json') && file !== 'en.json')
  .map(file => file.slice(0, -'.json'.length));

describe('account-security dispatch request', () => {
  it('accepts an event with or without a device and location', () => {
    expect(internalDispatchRequestSchema.parse(request)).toEqual(request);
    const bare = { ...request, device: null, location: null };
    expect(internalDispatchRequestSchema.parse(bare)).toEqual(bare);
  });

  it('rejects an event this build does not send', () => {
    expect(
      internalDispatchRequestSchema.safeParse({ ...request, event: 'password_changed' }).success
    ).toBe(false);
  });

  it('rejects an empty or oversized label and a missing idempotency key', () => {
    expect(internalDispatchRequestSchema.safeParse({ ...request, device: '' }).success).toBe(false);
    expect(
      internalDispatchRequestSchema.safeParse({ ...request, location: 'x'.repeat(121) }).success
    ).toBe(false);
    expect(
      internalDispatchRequestSchema.safeParse({ ...request, idempotencyKey: '' }).success
    ).toBe(false);
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

  it('picks the body sentence for what the request carried', () => {
    const bodies = [
      accountSecurityPushCopy({
        event: 'new_sign_in',
        device: 'Safari on iOS',
        location: 'Oslo, NO',
      }),
      accountSecurityPushCopy({ event: 'new_sign_in', device: 'Safari on iOS', location: null }),
      accountSecurityPushCopy({ event: 'new_sign_in', device: null, location: 'Oslo, NO' }),
      accountSecurityPushCopy({ event: 'new_sign_in', device: null, location: null }),
    ].map(copy => copy.body);

    expect(bodies).toEqual([
      'From Safari on iOS near Oslo, NO. Not you? Review your account security now.',
      'From Safari on iOS. Not you? Review your account security now.',
      'Near Oslo, NO. Not you? Review your account security now.',
      'Not you? Review your account security now.',
    ]);
  });

  it('renders its own translated title and body for every event in every shipped locale', () => {
    expect(SHIPPED_LOCALES.length).toBeGreaterThan(80);
    for (const event of ACCOUNT_SECURITY_EVENTS) {
      const copy = accountSecurityPushCopy({
        event,
        device: 'Edge on Windows',
        location: 'Rome, IT',
      });
      const titleKey = pushTitleCatalogKey(copy.i18nKey);
      const bodyKey = pushBodyCatalogKey(copy.i18nKey);
      expect(translatePush('en', titleKey, copy.i18nParams, '')).toBe(copy.title);
      expect(translatePush('en', bodyKey, copy.i18nParams, '')).toBe(copy.body);
      for (const locale of SHIPPED_LOCALES) {
        const title = translatePush(locale, titleKey, copy.i18nParams, '');
        const body = translatePush(locale, bodyKey, copy.i18nParams, '');
        expect(title, `${locale} ${event} title`).not.toBe(copy.title);
        expect(body, `${locale} ${event} body`).not.toBe(copy.body);
        expect(body, `${locale} ${event} body`).toContain('Edge on Windows');
        expect(body, `${locale} ${event} body`).toContain('Rome, IT');
      }
    }
  });
});
