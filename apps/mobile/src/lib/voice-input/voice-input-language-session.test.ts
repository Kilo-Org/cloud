import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SUPPORTED_LANGUAGES } from '@/i18n/languages';

import {
  __resetVoiceInputLanguageTagCacheForTests,
  reconcileVoiceInputLanguageTag,
  resolveVoiceInputSessionLanguageTag,
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

describe('reconcileVoiceInputLanguageTag', () => {
  it('returns null for the Automatic choice', () => {
    expect(reconcileVoiceInputLanguageTag(null, ['de-DE'])).toBeNull();
  });

  it('keeps an exact match in the option list spelling', () => {
    expect(reconcileVoiceInputLanguageTag('en_US', ['en-US', 'de-DE'])).toBe('en-US');
  });

  it('maps a gateway app tag onto the device locale sharing its language (zh-Hans → zh-CN)', () => {
    expect(reconcileVoiceInputLanguageTag('zh-Hans', ['zh-CN', 'de-DE'])).toBe('zh-CN');
  });

  it('maps a device locale onto the gateway app language (de-DE → de)', () => {
    expect(reconcileVoiceInputLanguageTag('de-DE', SUPPORTED_LANGUAGES)).toBe('de');
  });

  it('returns null when no option shares the stored language', () => {
    expect(reconcileVoiceInputLanguageTag('fil-PH', ['en-US', 'de-DE'])).toBeNull();
  });
});

describe('resolveVoiceInputSessionLanguageTag', () => {
  beforeEach(() => {
    __resetVoiceInputLanguageTagCacheForTests();
    vi.clearAllMocks();
  });

  it('starts in the stored gateway tag when it maps to an app language (de-DE → de)', async () => {
    expect(await resolveVoiceInputSessionLanguageTag('de-DE', 'gateway', 'en')).toBe('de');
  });

  it('does not fetch device locales for a gateway-mode resolve', async () => {
    await resolveVoiceInputSessionLanguageTag('de-DE', 'gateway', 'en');

    expect(getSupportedLocalesMock).not.toHaveBeenCalled();
  });

  it('reconciles a gateway tag onto the device locale in device mode (zh-Hans → zh-CN)', async () => {
    getSupportedLocalesMock.mockResolvedValue({
      locales: ['zh-CN', 'de-DE'],
      installedLocales: [],
    });

    expect(await resolveVoiceInputSessionLanguageTag('zh-Hans', 'device', 'en')).toBe('zh-CN');
  });

  it('falls back to the app/device resolution when the stored tag has no option in the mode', async () => {
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'de-DE' }]);
    getSupportedLocalesMock.mockResolvedValue({
      locales: ['de-DE', 'en-US'],
      installedLocales: [],
    });

    expect(await resolveVoiceInputSessionLanguageTag('fil-PH', 'device', 'de')).toBe('de-DE');
  });

  it('resolves fresh for the Automatic choice', async () => {
    localizationMock.getLocales.mockReturnValue([{ languageTag: 'nl-NL' }]);
    getSupportedLocalesMock.mockResolvedValue({
      locales: ['en-US', 'nl-NL'],
      installedLocales: [],
    });

    expect(await resolveVoiceInputSessionLanguageTag(null, 'device', 'nl')).toBe('nl-NL');
  });

  it('keeps the stored tag when the device locale probe fails', async () => {
    getSupportedLocalesMock.mockRejectedValueOnce(new Error('service unavailable'));

    expect(await resolveVoiceInputSessionLanguageTag('nl-NL', 'device', 'en')).toBe('nl-NL');
  });

  it('keeps the stored tag when the service reports no locales', async () => {
    getSupportedLocalesMock.mockResolvedValue({ locales: [], installedLocales: [] });

    expect(await resolveVoiceInputSessionLanguageTag('nl-NL', 'device', 'en')).toBe('nl-NL');
  });
});
