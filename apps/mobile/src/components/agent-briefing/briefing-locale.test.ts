import { describe, expect, it } from 'vitest';

import { resolveBriefingLocale } from './briefing-locale';

describe('resolveBriefingLocale', () => {
  it('resolves a requested regional tag to the tag whose catalog loaded', () => {
    expect(resolveBriefingLocale({ language: 'en-US', resolvedLanguage: 'en' })).toBe('en');
  });

  it('keeps the requested tag when i18next resolved none', () => {
    expect(resolveBriefingLocale({ language: 'en-US' })).toBe('en-US');
  });

  it('keeps the requested tag when resolvedLanguage is undefined', () => {
    expect(resolveBriefingLocale({ language: 'en-US', resolvedLanguage: undefined })).toBe('en-US');
  });
});
