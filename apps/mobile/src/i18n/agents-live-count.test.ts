import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import en from './locales/en.json';

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

describe('agents.liveCount', () => {
  it.each([
    { count: 1, text: '1 LIVE', key: 'agents.liveCount_one' },
    { count: 3, text: '3 LIVE', key: 'agents.liveCount_other' },
    { count: 4, text: '4 LIVE', key: 'agents.liveCount_other' },
    { count: 12, text: '12 LIVE', key: 'agents.liveCount_other' },
  ])('resolves $count through $key', ({ count, text, key }) => {
    expect(i18n.t('agents.liveCount', { count, returnDetails: true })).toMatchObject({
      res: text,
      exactUsedKey: key,
    });
  });
});
