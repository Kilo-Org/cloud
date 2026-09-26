import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import en from '@/i18n/locales/en.json';

// The checks card selects its copy by number. Mounting the section mocks
// react-i18next, so this suite resolves the same keys through i18next with the
// app's own config (src/i18n/index.ts) and the real en.json: a one-check PR
// must read "1 check", not "1 checks".
const i18n = createInstance();
await i18n.init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  compatibilityJSON: 'v4',
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

describe('prReview.checks.checksCount', () => {
  it.each([
    { count: 1, text: '1 check', key: 'prReview.checks.checksCount_one' },
    { count: 2, text: '2 checks', key: 'prReview.checks.checksCount_other' },
    { count: 3, text: '3 checks', key: 'prReview.checks.checksCount_other' },
  ])('resolves $count through $key', ({ count, text, key }) => {
    expect(
      i18n.t('prReview.checks.checksCount', {
        count,
        displayCount: String(count),
        returnDetails: true,
      })
    ).toMatchObject({ res: text, exactUsedKey: key });
  });
});

describe('prReview.checks status labels', () => {
  // The rows pass count alongside displayCount so a locale that inflects can
  // select a form. English has one form per status, so i18next falls back to
  // the base key and the label is unchanged.
  it.each([
    { count: 1, status: 'passed' },
    { count: 4, status: 'pending' },
  ])('keeps the $status label readable at count $count', ({ count, status }) => {
    expect(
      i18n.t(`prReview.checks.${status}`, {
        count,
        displayCount: String(count),
        returnDetails: true,
      })
    ).toMatchObject({ res: `${count} ${status}`, exactUsedKey: `prReview.checks.${status}` });
  });
});
