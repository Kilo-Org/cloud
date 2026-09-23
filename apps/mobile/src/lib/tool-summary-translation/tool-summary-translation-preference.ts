import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import {
  TOOL_SUMMARY_TRANSLATION_ENABLED_KEY,
  TOOL_SUMMARY_TRANSLATION_MODEL_KEY,
} from '@/lib/storage-keys';

import {
  DEFAULT_TOOL_SUMMARY_TRANSLATION_MODEL,
  setConfig,
} from './tool-summary-translation-runtime';

/**
 * The persisted tool-summary translation model choice. `name` is kept beside
 * `id` so the settings row can show the human-readable label without a second
 * lookup after restart.
 */
export type ToolSummaryTranslationModel = { id: string; name: string };

/** Wire contract for the persisted model JSON. Untrusted disk content at the parse boundary. */
const ToolSummaryTranslationModelSchema = z.object({ id: z.string(), name: z.string() });

/**
 * Default-off preference: translation sends every tool summary to the Kilo
 * gateway, so it is opt-in.
 */
const enabledStore = createSecureStorePreference<boolean>({
  key: TOOL_SUMMARY_TRANSLATION_ENABLED_KEY,
  defaultValue: false,
  parse: raw => raw === 'true',
  serialize: value => (value ? 'true' : 'false'),
});

const modelStore = createSecureStorePreference<ToolSummaryTranslationModel>({
  key: TOOL_SUMMARY_TRANSLATION_MODEL_KEY,
  defaultValue: DEFAULT_TOOL_SUMMARY_TRANSLATION_MODEL,
  parse: raw => {
    if (raw === null) {
      return DEFAULT_TOOL_SUMMARY_TRANSLATION_MODEL;
    }
    try {
      return ToolSummaryTranslationModelSchema.parse(JSON.parse(raw));
    } catch {
      // A corrupt persisted value never blocks start: fall back to the default
      // model instead of crashing the transcript.
      return DEFAULT_TOOL_SUMMARY_TRANSLATION_MODEL;
    }
  },
  serialize: value => JSON.stringify(value),
});

export function isToolSummaryTranslationEnabled(): boolean {
  return enabledStore.get();
}

export function readToolSummaryTranslationModel(): ToolSummaryTranslationModel {
  return modelStore.get();
}

export function setToolSummaryTranslationEnabled(next: boolean): void {
  enabledStore.set(next);
}

/** Alias the settings registry writes through, mirroring its writer naming. */
export const writeToolSummaryTranslationEnabled = setToolSummaryTranslationEnabled;

export function writeToolSummaryTranslationModel(next: ToolSummaryTranslationModel): void {
  modelStore.set(next);
}

/**
 * True only once both disk reads have settled. The runtime must stay disabled
 * until then: the enabled preference can resolve before the persisted model, and
 * enabling on the default model would translate with a model the user did not
 * choose.
 */
function hasLoadedPreferences(): boolean {
  return enabledStore.getHasLoaded() && modelStore.getHasLoaded();
}

/**
 * The only bridge from disk to the pure runtime: both stores push the loaded or
 * changed preference into the runtime, which covers the app-start case too
 * because the module-scope preload emits when the reads settle. The first read
 * to settle cannot enable the runtime on its own — `hasLoadedPreferences` keeps
 * it off until the model is known too.
 */
function syncRuntime(): void {
  if (!hasLoadedPreferences()) {
    return;
  }
  setConfig({
    enabled: isToolSummaryTranslationEnabled(),
    model: readToolSummaryTranslationModel(),
  });
}

// Warm both disk reads at module scope so the runtime and the settings row see
// the persisted value without waiting for a React mount, then keep them in sync.
enabledStore.preload();
modelStore.preload();
enabledStore.subscribe(syncRuntime);
modelStore.subscribe(syncRuntime);

/** Settings UI and runtime binding for the tool-summary translation preference. */
export type ToolSummaryTranslationPreference = {
  enabled: boolean;
  model: ToolSummaryTranslationModel;
  hasLoaded: boolean;
  setEnabled: (next: boolean) => void;
  setModel: (next: ToolSummaryTranslationModel) => void;
};

export function useToolSummaryTranslationPreference(): ToolSummaryTranslationPreference {
  const enabled = useSyncExternalStore(enabledStore.subscribe, enabledStore.get);
  const model = useSyncExternalStore(modelStore.subscribe, modelStore.get);
  const enabledLoaded = useSyncExternalStore(enabledStore.subscribe, enabledStore.getHasLoaded);
  const modelLoaded = useSyncExternalStore(modelStore.subscribe, modelStore.getHasLoaded);
  return {
    enabled,
    model,
    hasLoaded: enabledLoaded && modelLoaded,
    setEnabled: setToolSummaryTranslationEnabled,
    setModel: writeToolSummaryTranslationModel,
  };
}

/**
 * Mount in the app root so importing this module at app start runs the
 * module-scope preload and sync. Renders nothing.
 */
export function ToolSummaryTranslationRuntimeBootstrap(): null {
  useToolSummaryTranslationPreference();
  return null;
}
