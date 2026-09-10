import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import {
  GATEWAY_TRANSCRIPTION_ENABLED_KEY,
  GATEWAY_TRANSCRIPTION_MODEL_KEY,
  GATEWAY_TRANSCRIPTION_PRIMARY_KEY,
} from '@/lib/storage-keys';

/**
 * The persisted gateway transcription model choice. `name` is kept beside `id`
 * so the settings row can show the human-readable label without a second
 * lookup after restart.
 */
export type GatewayTranscriptionModel = { id: string; name: string };

/** Wire contract for the persisted model JSON. Untrusted disk content at the parse boundary. */
const GatewayTranscriptionModelSchema = z.object({ id: z.string(), name: z.string() });

/**
 * Default-off preference: gateway transcription is opt-in because it sends
 * the recording to the Kilo gateway instead of the device's speech
 * recognition.
 */
const enabledStore = createSecureStorePreference<boolean>({
  key: GATEWAY_TRANSCRIPTION_ENABLED_KEY,
  defaultValue: false,
  parse: raw => raw === 'true',
  serialize: value => (value ? 'true' : 'false'),
});

const modelStore = createSecureStorePreference<GatewayTranscriptionModel | null>({
  key: GATEWAY_TRANSCRIPTION_MODEL_KEY,
  defaultValue: null,
  parse: raw => {
    if (raw === null) {
      return null;
    }
    try {
      return GatewayTranscriptionModelSchema.parse(JSON.parse(raw));
    } catch {
      // A corrupt persisted value never blocks start: fall back to
      // "no model chosen" instead of crashing the voice flow.
      return null;
    }
  },
  serialize: value => JSON.stringify(value),
});

/**
 * Default-on mode: the user who enables the gateway means it to lead voice
 * transcription, so only the exact stored string 'false' demotes it.
 */
const primaryStore = createSecureStorePreference<boolean>({
  key: GATEWAY_TRANSCRIPTION_PRIMARY_KEY,
  defaultValue: true,
  parse: raw => raw !== 'false',
  serialize: value => (value ? 'true' : 'false'),
});

// Warm both disk reads at module scope so the settings row and the first
// toggle see the persisted value without waiting for a React mount.
enabledStore.preload();
modelStore.preload();
primaryStore.preload();

export function isGatewayTranscriptionEnabled(): boolean {
  return enabledStore.get();
}

/** Non-React subscription for module-scope consumers (e.g. the native binding). */
export function subscribeToGatewayTranscriptionEnabled(listener: () => void): () => void {
  return enabledStore.subscribe(listener);
}

export function setGatewayTranscriptionEnabled(value: boolean): void {
  enabledStore.set(value);
}

export function readGatewayTranscriptionModel(): GatewayTranscriptionModel | null {
  return modelStore.get();
}

export function writeGatewayTranscriptionModel(model: GatewayTranscriptionModel | null): void {
  modelStore.set(model);
}

/** Whether the gateway leads transcription when the switch is on (default true). */
export function isGatewayTranscriptionPrimary(): boolean {
  return primaryStore.get();
}

/** Non-React subscription for module-scope consumers (e.g. the engine dispatch). */
export function subscribeToGatewayTranscriptionPrimary(listener: () => void): () => void {
  return primaryStore.subscribe(listener);
}

export function setGatewayTranscriptionPrimary(value: boolean): void {
  primaryStore.set(value);
}

/** Settings UI binding for the gateway-transcription switch. */
export function useGatewayTranscriptionPreference() {
  const gatewayTranscriptionEnabled = useSyncExternalStore(
    enabledStore.subscribe,
    enabledStore.get
  );
  const hasLoaded = useSyncExternalStore(enabledStore.subscribe, enabledStore.getHasLoaded);
  return { gatewayTranscriptionEnabled, hasLoaded, setGatewayTranscriptionEnabled };
}

/** Settings UI binding for the chosen transcription model. */
export function useGatewayTranscriptionModel(): GatewayTranscriptionModel | null {
  return useSyncExternalStore(modelStore.subscribe, modelStore.get);
}

/**
 * Settings UI binding for whether the stored model choice has finished its
 * SecureStore read. The picker gates its rows on this so the check mark never
 * renders from a half-read store (a pending read reports "no model", which
 * would draw every row unchecked until the read lands).
 */
export function useGatewayTranscriptionModelLoaded(): boolean {
  return useSyncExternalStore(modelStore.subscribe, modelStore.getHasLoaded);
}

/** Settings UI binding for the gateway "use as primary" mode toggle. */
export function useGatewayTranscriptionPrimaryPreference() {
  const gatewayTranscriptionPrimary = useSyncExternalStore(
    primaryStore.subscribe,
    primaryStore.get
  );
  const hasLoaded = useSyncExternalStore(primaryStore.subscribe, primaryStore.getHasLoaded);
  return { gatewayTranscriptionPrimary, hasLoaded, setGatewayTranscriptionPrimary };
}
