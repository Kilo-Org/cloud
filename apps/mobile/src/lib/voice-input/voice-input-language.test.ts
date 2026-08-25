import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetVoiceInputLanguageTagCacheForTests,
  pickSupportedVoiceInputLanguageTag,
  resolveVoiceInputLanguageTag,
  resolveVoiceInputStartLanguageTag,
} from './voice-input-language';

const localizationMock = vi.hoisted(() => ({
  getLocales: vi.fn<() => { languageTag: string }[]>(() => [{ languageTag: 'en-US' }]),
}));

const getSupportedLocalesMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ locales: string[]; installedLocales: string[] }>>().mockResolvedValue({
    locales: [],
    installedLocales: [],
  })
);

vi.mock('expo-localization', () => ({
  getLocales: localizationMock.getLocales,
}));

vi.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    getSupportedLocales: getSupportedLocalesMock,
  },
}));

describe('resolveVoiceInputLanguageTag', () => {
  it('falls back to en-US when the locales array is empty', () => {
    expect(resolveVoiceInputLanguageTag([])).toBe('en-US');
  });

  it('falls back to en-US when the first locale has no languageTag', () => {
    expect(resolveVoiceInputLanguageTag([{}])).toBe('en-US');
  });

  it('falls back to en-US when the first locale languageTag is empty', () => {
    expect(resolveVoiceInputLanguageTag([{ languageTag: '' }])).toBe('en-US');
  });

  it('returns the first locale languageTag when it is populated', () => {
    expect(resolveVoiceInputLanguageTag([{ languageTag: 'nl-NL' }])).toBe('nl-NL');
  });

  it('ignores later locales', () => {
    expect(resolveVoiceInputLanguageTag([{ languageTag: 'fr-FR' }, { languageTag: 'de-DE' }])).toBe(
      'fr-FR'
    );
  });
});

describe('pickSupportedVoiceInputLanguageTag', () => {
  it('returns the supported spelling on exact match (device en_US → supported en-US)', () => {
    expect(pickSupportedVoiceInputLanguageTag(['en_US'], ['en-US'])).toBe('en-US');
  });

  it('region-shifted English lands on en-US via tie-break ii, not sorted-first en-AU', () => {
    expect(
      pickSupportedVoiceInputLanguageTag(['en-DE'], ['de-DE', 'en-AU', 'en-GB', 'en-US'])
    ).toBe('en-US');
  });

  it('eponymous-region tie-break i: de-AT → de-DE', () => {
    expect(pickSupportedVoiceInputLanguageTag(['de-AT'], ['de-DE', 'en-US'])).toBe('de-DE');
  });

  it('last-resort order tie-break iii: ar-EG → ar-SA (no ar-AR, no ar-US)', () => {
    expect(pickSupportedVoiceInputLanguageTag(['ar-EG'], ['ar-SA', 'en-US'])).toBe('ar-SA');
  });

  it('preference order beats second-language exact match: [en-DE, de-DE] vs [de-DE, en-US] → en-US', () => {
    expect(pickSupportedVoiceInputLanguageTag(['en-DE', 'de-DE'], ['de-DE', 'en-US'])).toBe(
      'en-US'
    );
  });

  it('second device tag used when first has no match: [fil-PH, en-US] vs [en-US] → en-US', () => {
    expect(pickSupportedVoiceInputLanguageTag(['fil-PH', 'en-US'], ['en-US'])).toBe('en-US');
  });

  it('returns null when no shared language', () => {
    expect(pickSupportedVoiceInputLanguageTag(['fil-PH'], ['en-US', 'de-DE'])).toBeNull();
  });

  it('region-less device tag: en → en-US', () => {
    expect(pickSupportedVoiceInputLanguageTag(['en'], ['en-GB', 'en-US'])).toBe('en-US');
  });

  it('underscore-form supported identifier returns the original spelling', () => {
    expect(pickSupportedVoiceInputLanguageTag(['en-DE'], ['en_US'])).toBe('en_US');
  });
});

describe('resolveVoiceInputStartLanguageTag', () => {
  beforeEach(() => {
    __resetVoiceInputLanguageTagCacheForTests();
    vi.clearAllMocks();
  });

  it('returns the device tag when the supported list contains an exact match (nl-NL)', async () => {
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'nl-NL' }]);
    getSupportedLocalesMock.mockResolvedValue({
      locales: ['en-US', 'nl-NL'],
      installedLocales: [],
    });

    const tag = await resolveVoiceInputStartLanguageTag('nl');
    expect(tag).toBe('nl-NL');
  });

  it('region-shifted en-DE resolves to en-US when supported contains en-AU and en-US', async () => {
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'en-DE' }]);
    getSupportedLocalesMock.mockResolvedValue({
      locales: ['en-AU', 'en-US'],
      installedLocales: [],
    });

    const tag = await resolveVoiceInputStartLanguageTag('en');
    expect(tag).toBe('en-US');
  });

  it('returns the raw tag when the supported list is empty', async () => {
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'en-DE' }]);
    getSupportedLocalesMock.mockResolvedValue({ locales: [], installedLocales: [] });

    const tag = await resolveVoiceInputStartLanguageTag('en');
    expect(tag).toBe('en');
  });

  it('returns the raw tag when getSupportedLocales rejects, and retries on a later call', async () => {
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'en-DE' }]);
    getSupportedLocalesMock.mockRejectedValueOnce(new Error('network failure'));
    getSupportedLocalesMock.mockResolvedValueOnce({
      locales: ['en-AU', 'en-US'],
      installedLocales: [],
    });

    const first = await resolveVoiceInputStartLanguageTag('en');
    expect(first).toBe('en');

    const second = await resolveVoiceInputStartLanguageTag('en');
    expect(second).toBe('en-US');
  });

  it('returns the raw tag when getSupportedLocales throws synchronously', async () => {
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'en-DE' }]);
    getSupportedLocalesMock.mockImplementationOnce(() => {
      throw new Error('package not found');
    });

    const tag = await resolveVoiceInputStartLanguageTag('en');
    expect(tag).toBe('en');
  });

  it('returns the raw tag as pass-through when no match in a non-empty list', async () => {
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'fil-PH' }]);
    getSupportedLocalesMock.mockResolvedValue({ locales: ['en-US'], installedLocales: [] });

    const tag = await resolveVoiceInputStartLanguageTag('fil');
    expect(tag).toBe('fil');
  });

  it('uses the selected app language before a different device language', async () => {
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'nl-NL' }]);
    getSupportedLocalesMock.mockResolvedValue({
      locales: ['nl-NL', 'fr-FR'],
      installedLocales: [],
    });

    expect(await resolveVoiceInputStartLanguageTag('fr')).toBe('fr-FR');
  });
});
