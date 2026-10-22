import type * as voiceInputLanguagePreference from './voice-input-language-preference';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
const { captureException, toastError } = vi.hoisted(() => ({
  captureException: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    await Promise.resolve();
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    store.delete(key);
  }),
}));
vi.mock('@sentry/react-native', () => ({ captureException }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

const LANGUAGE_KEY = 'voice-input-language';

/**
 * Fresh module instance per import: the store is module-scoped and preload()
 * runs at import time, so the disk contents must be arranged before the
 * import for a test to observe them.
 */
// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function importPreferenceModule(): Promise<typeof voiceInputLanguagePreference> {
  return import('./voice-input-language-preference');
}

beforeEach(() => {
  store.clear();
  vi.resetModules();
  captureException.mockReset();
  toastError.mockReset();
});

describe('voice input language preference', () => {
  it('reads null by default when nothing is persisted', async () => {
    const mod = await importPreferenceModule();
    await mod.whenVoiceInputLanguageLoaded();

    expect(mod.readVoiceInputLanguage()).toBeNull();
  });

  it('round-trips a chosen language through SecureStore across a module reload', async () => {
    const mod = await importPreferenceModule();
    await mod.whenVoiceInputLanguageLoaded();

    mod.writeVoiceInputLanguage('nl-NL');
    expect(mod.readVoiceInputLanguage()).toBe('nl-NL');
    await vi.waitFor(() => {
      expect(store.get(LANGUAGE_KEY)).toBe('nl-NL');
    });

    // A fresh module (next launch) reads the persisted choice.
    vi.resetModules();
    const reloaded = await importPreferenceModule();
    await reloaded.whenVoiceInputLanguageLoaded();
    expect(reloaded.readVoiceInputLanguage()).toBe('nl-NL');
  });

  it('persists null as an empty string and parses that empty string back to null', async () => {
    const mod = await importPreferenceModule();
    await mod.whenVoiceInputLanguageLoaded();

    mod.writeVoiceInputLanguage('nl-NL');
    await vi.waitFor(() => {
      expect(store.get(LANGUAGE_KEY)).toBe('nl-NL');
    });
    mod.writeVoiceInputLanguage(null);
    await vi.waitFor(() => {
      expect(store.get(LANGUAGE_KEY)).toBe('');
    });

    expect(mod.readVoiceInputLanguage()).toBeNull();

    // A stored empty string is the serialized form of "auto", not a language.
    vi.resetModules();
    const reloaded = await importPreferenceModule();
    await reloaded.whenVoiceInputLanguageLoaded();
    expect(reloaded.readVoiceInputLanguage()).toBeNull();
  });
});
