import type * as gatewayTranscriptionPreference from './gateway-transcription-preference';
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

const ENABLED_KEY = 'gateway-transcription-enabled';
const MODEL_KEY = 'gateway-transcription-model';

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
 * Fresh module instance per import: the stores are module-scoped and
 * preload() runs at import time, so the disk contents must be arranged
 * before the import for a test to observe them.
 */
// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function importPreferenceModule(): Promise<typeof gatewayTranscriptionPreference> {
  return import('./gateway-transcription-preference');
}

beforeEach(() => {
  store.clear();
  vi.resetModules();
  captureException.mockReset();
  toastError.mockReset();
});

describe('gateway transcription enabled preference', () => {
  it('reads false by default when nothing is persisted', async () => {
    const mod = await importPreferenceModule();
    await flushPreferences();

    expect(mod.isGatewayTranscriptionEnabled()).toBe(false);
  });

  it('round-trips through SecureStore across a module reload', async () => {
    const mod = await importPreferenceModule();
    await flushPreferences();

    mod.setGatewayTranscriptionEnabled(true);
    expect(mod.isGatewayTranscriptionEnabled()).toBe(true);
    await flushPreferences();
    expect(store.get(ENABLED_KEY)).toBe('true');

    // A fresh module (next launch) reads the persisted value.
    vi.resetModules();
    const reloaded = await importPreferenceModule();
    await flushPreferences();
    expect(reloaded.isGatewayTranscriptionEnabled()).toBe(true);
  });

  it('persists false when toggled off after being on', async () => {
    store.set(ENABLED_KEY, 'true');
    const mod = await importPreferenceModule();
    await flushPreferences();

    mod.setGatewayTranscriptionEnabled(false);
    await flushPreferences();

    expect(mod.isGatewayTranscriptionEnabled()).toBe(false);
    expect(store.get(ENABLED_KEY)).toBe('false');
  });
});

describe('gateway transcription model', () => {
  it('round-trips the chosen model and persists its JSON', async () => {
    const mod = await importPreferenceModule();
    await flushPreferences();
    expect(mod.readGatewayTranscriptionModel()).toBeNull();

    const model: gatewayTranscriptionPreference.GatewayTranscriptionModel = {
      id: 'whisper-large-v3',
      name: 'Whisper Large v3',
    };
    mod.writeGatewayTranscriptionModel(model);
    expect(mod.readGatewayTranscriptionModel()).toEqual(model);
    await flushPreferences();
    expect(store.get(MODEL_KEY)).toBe(JSON.stringify(model));

    // A fresh module (next launch) reads the persisted model.
    vi.resetModules();
    const reloaded = await importPreferenceModule();
    await flushPreferences();
    expect(reloaded.readGatewayTranscriptionModel()).toEqual(model);
  });

  it('reads a corrupt persisted model as null', async () => {
    store.set(MODEL_KEY, 'not-json');
    const mod = await importPreferenceModule();
    await flushPreferences();

    expect(mod.readGatewayTranscriptionModel()).toBeNull();
  });

  it('reads a persisted model that is not an id/name object as null', async () => {
    store.set(MODEL_KEY, '42');
    const mod = await importPreferenceModule();
    await flushPreferences();

    expect(mod.readGatewayTranscriptionModel()).toBeNull();
  });

  it('reads a model missing the name field as null', async () => {
    store.set(MODEL_KEY, JSON.stringify({ id: 'whisper-large-v3' }));
    const mod = await importPreferenceModule();
    await flushPreferences();

    expect(mod.readGatewayTranscriptionModel()).toBeNull();
  });

  it('clears the model back to null', async () => {
    const mod = await importPreferenceModule();
    await flushPreferences();
    mod.writeGatewayTranscriptionModel({ id: 'whisper-large-v3', name: 'Whisper Large v3' });
    await flushPreferences();

    mod.writeGatewayTranscriptionModel(null);
    await flushPreferences();

    expect(mod.readGatewayTranscriptionModel()).toBeNull();
    expect(store.get(MODEL_KEY)).toBe('null');
  });
});
