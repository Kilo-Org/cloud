import type * as toolSummaryTranslationPreference from './tool-summary-translation-preference';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
/** Gate the model disk read so a test can let the enabled read settle first. */
const modelReadGate = vi.hoisted(() => ({ current: Promise.withResolvers<undefined>() }));
const { captureException, toastError } = vi.hoisted(() => ({
  captureException: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    if (key === 'tool-summary-translation-model') {
      await modelReadGate.current.promise;
    }
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

const ENABLED_KEY = 'tool-summary-translation-enabled';
const MODEL_KEY = 'tool-summary-translation-model';
const DEFAULT_MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

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
function importPreferenceModule(): Promise<typeof toolSummaryTranslationPreference> {
  return import('./tool-summary-translation-preference');
}

beforeEach(() => {
  store.clear();
  // Default: the model read is unblocked; individual tests replace the gate.
  modelReadGate.current = Promise.withResolvers<undefined>();
  modelReadGate.current.resolve(undefined);
  vi.resetModules();
  captureException.mockReset();
  toastError.mockReset();
});

describe('tool summary translation enabled preference', () => {
  it('reads false by default when nothing is persisted', async () => {
    const mod = await importPreferenceModule();
    await flushPreferences();

    expect(mod.isToolSummaryTranslationEnabled()).toBe(false);
  });

  it('round-trips through SecureStore across a module reload', async () => {
    const mod = await importPreferenceModule();
    await flushPreferences();

    mod.setToolSummaryTranslationEnabled(true);
    expect(mod.isToolSummaryTranslationEnabled()).toBe(true);
    await flushPreferences();
    expect(store.get(ENABLED_KEY)).toBe('true');

    // A fresh module (next launch) reads the persisted value.
    vi.resetModules();
    const reloaded = await importPreferenceModule();
    await flushPreferences();
    expect(reloaded.isToolSummaryTranslationEnabled()).toBe(true);
  });
});

describe('tool summary translation model', () => {
  it('reads the Auto Small default when nothing is persisted', async () => {
    const mod = await importPreferenceModule();
    await flushPreferences();

    expect(mod.readToolSummaryTranslationModel()).toEqual(DEFAULT_MODEL);
  });

  it('round-trips the chosen model and persists its JSON', async () => {
    const mod = await importPreferenceModule();
    await flushPreferences();

    const model: toolSummaryTranslationPreference.ToolSummaryTranslationModel = {
      id: 'kilo-auto/frontier',
      name: 'Auto Frontier',
    };
    mod.writeToolSummaryTranslationModel(model);
    expect(mod.readToolSummaryTranslationModel()).toEqual(model);
    await flushPreferences();
    expect(store.get(MODEL_KEY)).toBe(JSON.stringify(model));

    // A fresh module (next launch) reads the persisted model.
    vi.resetModules();
    const reloaded = await importPreferenceModule();
    await flushPreferences();
    expect(reloaded.readToolSummaryTranslationModel()).toEqual(model);
  });

  it('reads corrupt persisted model JSON as the default', async () => {
    store.set(MODEL_KEY, 'not-json');
    const mod = await importPreferenceModule();
    await flushPreferences();

    expect(mod.readToolSummaryTranslationModel()).toEqual(DEFAULT_MODEL);
  });

  it('reads a persisted model that is not an id/name object as the default', async () => {
    store.set(MODEL_KEY, '42');
    const mod = await importPreferenceModule();
    await flushPreferences();

    expect(mod.readToolSummaryTranslationModel()).toEqual(DEFAULT_MODEL);
  });

  it('syncs the module-scope disk read into the runtime config', async () => {
    store.set(ENABLED_KEY, 'true');
    store.set(MODEL_KEY, JSON.stringify({ id: 'kilo-auto/frontier', name: 'Auto Frontier' }));
    await importPreferenceModule();
    await flushPreferences();

    const runtime = await import('./tool-summary-translation-runtime');
    expect(runtime.getConfig()).toEqual({
      enabled: true,
      model: { id: 'kilo-auto/frontier', name: 'Auto Frontier' },
    });
  });

  it('pushes a later preference write into the runtime config', async () => {
    const mod = await importPreferenceModule();
    await flushPreferences();

    mod.setToolSummaryTranslationEnabled(true);
    await flushPreferences();

    const runtime = await import('./tool-summary-translation-runtime');
    expect(runtime.getConfig()).toEqual({ enabled: true, model: DEFAULT_MODEL });
  });
});

describe('cold-start hydration ordering', () => {
  it('keeps the runtime disabled until the persisted model read also settles', async () => {
    const persistedModel = { id: 'kilo-auto/frontier', name: 'Auto Frontier' };
    store.set(ENABLED_KEY, 'true');
    store.set(MODEL_KEY, JSON.stringify(persistedModel));
    // Block the model read so the enabled preference settles first.
    modelReadGate.current = Promise.withResolvers<undefined>();

    await importPreferenceModule();
    await flushPreferences();

    const runtime = await import('./tool-summary-translation-runtime');
    // The enabled preference has settled, the persisted model has not: the
    // runtime must stay disabled so no summary is translated on the default
    // model the user did not choose.
    expect(runtime.getConfig()).toEqual({ enabled: false, model: DEFAULT_MODEL });

    modelReadGate.current.resolve(undefined);
    await flushPreferences();

    // Once both reads settle, the config lands atomically with the persisted model.
    expect(runtime.getConfig()).toEqual({ enabled: true, model: persistedModel });
  });
});
