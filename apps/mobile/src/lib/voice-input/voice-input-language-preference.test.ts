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

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushPreferences(): Promise<void> {
  // The module-scope preload reads SecureStore in the background; two
  // macrotask rounds let the read, parse and emit settle before assertions.
  return new Promise(resolve => {
    setImmediate(() => {
      setImmediate(resolve);
    });
  });
}

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
    await flushPreferences();

    expect(mod.readVoiceInputLanguage()).toBeNull();
  });

  it('round-trips a chosen language through SecureStore across a module reload', async () => {
    const mod = await importPreferenceModule();
    await flushPreferences();

    mod.writeVoiceInputLanguage('nl-NL');
    expect(mod.readVoiceInputLanguage()).toBe('nl-NL');
    await flushPreferences();
    expect(store.get(LANGUAGE_KEY)).toBe('nl-NL');

    // A fresh module (next launch) reads the persisted choice.
    vi.resetModules();
    const reloaded = await importPreferenceModule();
    await flushPreferences();
    expect(reloaded.readVoiceInputLanguage()).toBe('nl-NL');
  });

  it('persists null as an empty string and parses that empty string back to null', async () => {
    const mod = await importPreferenceModule();
    await flushPreferences();

    mod.writeVoiceInputLanguage('nl-NL');
    await flushPreferences();
    mod.writeVoiceInputLanguage(null);
    await flushPreferences();

    expect(mod.readVoiceInputLanguage()).toBeNull();
    expect(store.get(LANGUAGE_KEY)).toBe('');

    // A stored empty string is the serialized form of "auto", not a language.
    vi.resetModules();
    const reloaded = await importPreferenceModule();
    await flushPreferences();
    expect(reloaded.readVoiceInputLanguage()).toBeNull();
  });
});
