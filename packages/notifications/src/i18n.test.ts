import { describe, expect, it } from 'vitest';

import { resolvePushLocale, translatePush } from './i18n';

describe('translatePush', () => {
  it('translates a key into Spanish for the es locale', () => {
    expect(translatePush('es', 'generic.body.chatMessage')).toBe('Tienes un mensaje nuevo');
  });

  it('returns English for the en locale', () => {
    expect(translatePush('en', 'generic.body.chatMessage')).toBe('You have a new message');
  });

  it('interpolates params into the translated string', () => {
    expect(translatePush('es', 'instanceLifecycle.ready.title', { instanceName: 'Mi Bot' })).toBe(
      'Mi Bot está listo'
    );
  });

  it('falls back to English for an unknown locale', () => {
    expect(translatePush('xx', 'generic.body.chatMessage')).toBe('You have a new message');
  });

  it('falls back to English for a null locale', () => {
    expect(translatePush(null, 'generic.body.chatMessage')).toBe('You have a new message');
  });

  it('returns the key itself when the key is unknown and no fallback is given', () => {
    expect(translatePush('es', 'missing.key')).toBe('missing.key');
  });

  it('returns the fallback string when the key is unknown and a fallback is given', () => {
    expect(translatePush('es', 'missing.key', undefined, 'Fallback English')).toBe(
      'Fallback English'
    );
  });
});

describe('spend-alert catalog translations', () => {
  it('translates the Icelandic spend-alert push and internal copy', () => {
    expect(translatePush('is', 'generic.body.spendAlert')).toBe('Útgjöldin þín þarfnast athygli');
    expect(translatePush('is', 'internal.spendAlert.title')).toBe('Útgjaldaviðvörun');
    expect(
      translatePush('is', 'internal.spendAlert.body', { scopeName: 'Acme Corp', amountUsd: '12' })
    ).toBe('Útgjöld Acme Corp fóru yfir $12');
  });

  it('translates the Italian spend-alert push and internal copy', () => {
    expect(translatePush('it', 'generic.body.spendAlert')).toBe('La tua spesa richiede attenzione');
    expect(translatePush('it', 'internal.spendAlert.title')).toBe('Avviso di spesa');
    expect(
      translatePush('it', 'internal.spendAlert.body', { scopeName: 'Acme Corp', amountUsd: '12' })
    ).toBe('La spesa di Acme Corp ha superato $12');
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

  it('resolves supported tags to themselves', () => {
    expect(resolvePushLocale('fr')).toBe('fr');
    expect(resolvePushLocale('de')).toBe('de');
    expect(resolvePushLocale('zh-Hans')).toBe('zh-Hans');
  });
});
