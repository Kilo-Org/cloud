import { describe, expect, it, vi } from 'vitest';

import { parseLanguagePreference } from '@/lib/hooks/use-language-preference';
import { resolveLanguageTag } from './resolve-language';

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

  it('matches pt-BR exactly and falls back from other Portuguese tags to pt', () => {
    expect(resolveLanguageTag([{ languageTag: 'pt-BR' }])).toBe('pt-BR');
    expect(resolveLanguageTag([{ languageTag: 'pt-PT' }])).toBe('pt');
    expect(resolveLanguageTag([{ languageTag: 'pt' }])).toBe('pt');
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
