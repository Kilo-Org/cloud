import { describe, expect, it, vi } from 'vitest';

import { parseLanguagePreference } from '@/lib/hooks/use-language-preference';
import { resolveLanguageTag, resolveSupportedLanguageTag } from './resolve-language';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

const localizationMock = vi.hoisted(() => ({
  getLocales: vi.fn<() => { languageTag: string }[]>(() => [{ languageTag: 'en-US' }]),
}));
vi.mock('expo-localization', () => ({ getLocales: localizationMock.getLocales }));

describe('resolveLanguageTag', () => {
  it('resolves an empty locale list to en', () => {
    expect(resolveLanguageTag([])).toBe('en');
  });

  it('resolves Portuguese tags to pt-BR unless they name Portugal', () => {
    // iOS reports a pt-BR device as the bare tag `pt` with the region in
    // `regionCode`, not in `languageTag`.
    expect(
      resolveLanguageTag([{ languageTag: 'pt', regionCode: 'BR' } as const])
    ).toBe('pt-BR');
    expect(resolveLanguageTag([{ languageTag: 'pt-PT' }])).toBe('pt');
    expect(resolveLanguageTag([{ languageTag: 'pt', regionCode: 'PT' } as const])).toBe('pt');
    expect(resolveLanguageTag([{ languageTag: 'pt' }])).toBe('pt-BR');
    expect(resolveLanguageTag([{ languageTag: 'pt-US' }])).toBe('pt-BR');
  });

  it('matches es-MX to es via the same-language fallback', () => {
    expect(resolveLanguageTag([{ languageTag: 'es-MX' }])).toBe('es');
  });

  it('resolves an unsupported language to en', () => {
    expect(resolveLanguageTag([{ languageTag: 'xx-YY' }])).toBe('en');
  });

  it('resolves zh-Hant-TW to zh-Hant', () => {
    expect(resolveLanguageTag([{ languageTag: 'zh-Hant-TW' }])).toBe('zh-Hant');
  });

  it('resolves zh-Hant-HK to zh-Hant', () => {
    expect(resolveLanguageTag([{ languageTag: 'zh-Hant-HK' }])).toBe('zh-Hant');
  });

  it('resolves zh-TW to zh-Hant', () => {
    expect(resolveLanguageTag([{ languageTag: 'zh-TW' }])).toBe('zh-Hant');
  });

  it('resolves zh-HK to zh-Hant', () => {
    expect(resolveLanguageTag([{ languageTag: 'zh-HK' }])).toBe('zh-Hant');
  });

  it('resolves zh-MO to zh-Hant', () => {
    expect(resolveLanguageTag([{ languageTag: 'zh-MO' }])).toBe('zh-Hant');
  });

  it('resolves zh-Hans-CN to zh-Hans', () => {
    expect(resolveLanguageTag([{ languageTag: 'zh-Hans-CN' }])).toBe('zh-Hans');
  });

  it('resolves zh-CN to zh-Hans', () => {
    expect(resolveLanguageTag([{ languageTag: 'zh-CN' }])).toBe('zh-Hans');
  });

  it('resolves zh to zh-Hans', () => {
    expect(resolveLanguageTag([{ languageTag: 'zh' }])).toBe('zh-Hans');
  });

  it('resolves the Android speech tag cmn-Hans-CN to zh-Hans', () => {
    // Android's speech service names Mandarin with the ISO 639-3 code `cmn`;
    // the app ships it as the zh scripts (p16, p4).
    expect(resolveSupportedLanguageTag([{ languageTag: 'cmn-Hans-CN' }])).toBe('zh-Hans');
  });

  it('resolves the Android speech tag cmn-Hant-TW to zh-Hant', () => {
    expect(resolveSupportedLanguageTag([{ languageTag: 'cmn-Hant-TW' }])).toBe('zh-Hant');
  });

  it('resolves a bare cmn tag to zh-Hans', () => {
    expect(resolveSupportedLanguageTag([{ languageTag: 'cmn' }])).toBe('zh-Hans');
  });
});

describe('resolveSupportedLanguageTag', () => {
  it('returns null where resolveLanguageTag falls back to en', () => {
    expect(resolveSupportedLanguageTag([])).toBeNull();
    expect(resolveSupportedLanguageTag([{ languageTag: 'xx-YY' }])).toBeNull();
  });

  it('matches the whole tag, so pt-BR stays the Brazilian variant', () => {
    expect(resolveSupportedLanguageTag([{ languageTag: 'pt-BR' }])).toBe('pt-BR');
  });

  it('resolves the iOS bare-pt shape with a Brazilian regionCode to pt-BR', () => {
    expect(resolveSupportedLanguageTag([{ languageTag: 'pt', regionCode: 'BR' }])).toBe('pt-BR');
  });

  it('resolves pt-PT to the Portugal variant', () => {
    expect(resolveSupportedLanguageTag([{ languageTag: 'pt-PT' }])).toBe('pt');
  });
});

describe('parseLanguagePreference', () => {
  it('maps a bad stored value to device', () => {
    expect(parseLanguagePreference('garbage')).toBe('device');
  });

  it('maps null to device', () => {
    expect(parseLanguagePreference(null)).toBe('device');
  });

  it('keeps a supported tag', () => {
    expect(parseLanguagePreference('es')).toBe('es');
  });
});
