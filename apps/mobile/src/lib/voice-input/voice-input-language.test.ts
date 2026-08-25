import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetVoiceInputLanguageTagCacheForTests,
  pickSupportedVoiceInputLanguageTag,
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

  it('keeps the device Chinese script when only a region differs', () => {
    expect(pickSupportedVoiceInputLanguageTag(['zh-Hant-TW'], ['zh-CN', 'zh-Hant'])).toBe(
      'zh-Hant'
    );
  });

  it('keeps the Traditional script when the device names a Traditional region', () => {
    expect(pickSupportedVoiceInputLanguageTag(['zh-Hant', 'zh-TW'], ['zh-CN', 'zh-TW'])).toBe(
      'zh-TW'
    );
  });

  it('maps a Simplified script tag onto the Simplified region', () => {
    expect(pickSupportedVoiceInputLanguageTag(['zh-Hans'], ['zh-TW', 'zh-CN'])).toBe('zh-CN');
  });

  it('maps the HK region to Traditional Chinese', () => {
    expect(pickSupportedVoiceInputLanguageTag(['zh-HK'], ['zh-CN', 'zh-TW'])).toBe('zh-TW');
  });

  it('keeps the old behavior for a non-Chinese tag', () => {
    expect(pickSupportedVoiceInputLanguageTag(['de-AT'], ['de-DE', 'de-CH'])).toBe('de-DE');
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

  it('uses the matching device region for the selected app language', async () => {
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'en-GB' }]);
    getSupportedLocalesMock.mockResolvedValue({
      locales: ['en-US', 'en-GB'],
      installedLocales: [],
    });

    expect(await resolveVoiceInputStartLanguageTag('en')).toBe('en-GB');
  });

  it('keeps the selected Chinese script before a different device script', async () => {
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'zh-CN' }]);
    getSupportedLocalesMock.mockResolvedValue({
      locales: ['zh-CN', 'zh-Hant'],
      installedLocales: [],
    });

    expect(await resolveVoiceInputStartLanguageTag('zh-Hant')).toBe('zh-Hant');
  });
});
