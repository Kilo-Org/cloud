import { describe, expect, it } from 'vitest';

import { resolvePushLocale, translatePush } from './i18n';

describe('translatePush', () => {
  it('translates a key into Spanish for the es locale', () => {
    expect(translatePush('es', 'generic.body.lowBalance')).toBe('Tu saldo necesita atención');
  });

  it('returns English for the en locale', () => {
    expect(translatePush('en', 'generic.body.lowBalance')).toBe('Your balance needs attention');
  });

  it('interpolates params into the translated string', () => {
    expect(translatePush('en', 'internal.securityFindingNew.title', { severity: 'high' })).toBe(
      'New security finding (high)'
    );
  });

  it('falls back to English for an unknown locale', () => {
    expect(translatePush('xx', 'generic.body.lowBalance')).toBe('Your balance needs attention');
  });

  it('falls back to English for a null locale', () => {
    expect(translatePush(null, 'generic.body.lowBalance')).toBe('Your balance needs attention');
  });

  it('returns the given fallback when the key is unknown', () => {
    expect(translatePush('de', 'not.a.catalog.key', undefined, 'Something went wrong')).toBe(
      'Something went wrong'
    );
  });
});

describe('resolvePushLocale', () => {
  it('keeps a supported tag', () => {
    expect(resolvePushLocale('es')).toBe('es');
  });

  it('maps null and unsupported tags to en', () => {
    expect(resolvePushLocale(null)).toBe('en');
    expect(resolvePushLocale(undefined)).toBe('en');
    expect(resolvePushLocale('xx')).toBe('en');
  });

  it('maps Object.prototype property names to en', () => {
    // Membership must be an own-key check: inherited names like `constructor`
    // or `toString` are not catalog tags and must fall back to English.
    expect(resolvePushLocale('constructor')).toBe('en');
    expect(resolvePushLocale('toString')).toBe('en');
    expect(resolvePushLocale('valueOf')).toBe('en');
    expect(resolvePushLocale('__proto__')).toBe('en');
    expect(resolvePushLocale('hasOwnProperty')).toBe('en');
  });

  it('resolves supported tags to themselves', () => {
    expect(resolvePushLocale('fr')).toBe('fr');
    expect(resolvePushLocale('de')).toBe('de');
    expect(resolvePushLocale('zh-Hans')).toBe('zh-Hans');
  });
});
