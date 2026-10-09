import { type NativeModule, requireOptionalNativeModule } from 'expo';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { localModelProvider } from './local-models';

type DownloadEvent = {
  readonly status: 'downloading' | 'available' | 'error';
  readonly bytesDownloaded?: number;
  readonly bytesToDownload?: number;
  readonly reason?: string;
};

/** The download half of the Android module: one system download and its progress events. */
type DownloadBridge = {
  readonly download: () => Promise<void>;
  readonly addListener: (
    eventName: 'onModelDownload',
    listener: (event: DownloadEvent) => void
  ) => { remove: () => void };
};

export type ModelDownloadState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'downloading';
      readonly bytesDownloaded?: number;
      readonly bytesToDownload?: number;
    }
  | { readonly kind: 'failed' };

type ModelDownload = {
  /** Starts the system download. Only a user action calls this; nothing starts it on its own. */
  readonly start: () => Promise<void>;
  readonly current: () => ModelDownloadState;
  readonly subscribe: (listener: () => void) => () => void;
};

const IDLE: ModelDownloadState = { kind: 'idle' };
const FAILED: ModelDownloadState = { kind: 'failed' };

/**
 * One user-started download of the system model. The native promise is the
 * outcome; progress events only feed the progress line. Either way the
 * provider's status is asked again, so the settings row and the model picker
 * show what the system now reports.
 */
export function modelDownload(bridge: DownloadBridge, refresh: () => Promise<void>): ModelDownload {
  let state = IDLE;
  const listeners = new Set<() => void>();
  const set = (next: ModelDownloadState) => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    start: async () => {
      if (state.kind === 'downloading') {
        return;
      }
      set({ kind: 'downloading' });
      const subscription = bridge.addListener('onModelDownload', event => {
        if (event.status !== 'downloading' || state.kind !== 'downloading') {
          return;
        }
        set({
          kind: 'downloading',
          bytesDownloaded: event.bytesDownloaded ?? state.bytesDownloaded,
          bytesToDownload: event.bytesToDownload ?? state.bytesToDownload,
        });
      });
      let failed = false;
      try {
        await bridge.download();
      } catch {
        // The native reason is a stable code; the row shows fixed failure copy.
        failed = true;
      } finally {
        subscription.remove();
      }
      try {
        await refresh();
      } catch {
        // The status stays as last reported; the next screen mount asks again.
      }
      set(failed ? FAILED : IDLE);
    },
    current: () => state,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

type DownloadModule = InstanceType<
  typeof NativeModule<{ onModelDownload: (event: DownloadEvent) => void }>
> & { download: () => Promise<void> };

// The same Android-only module the inference provider loads in local-models.
const native =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<DownloadModule>('KiloAndroidModel')
    : null;

const android =
  native === null
    ? null
    : modelDownload(native, async () => {
        await localModelProvider('android')?.availability();
      });

const noSubscription = () => () => undefined;
const idle = () => IDLE;

/** The Android model download, or null on builds without the Android module. */
export function useAndroidModelDownload(): {
  readonly state: ModelDownloadState;
  readonly start: () => Promise<void>;
} | null {
  const state = useSyncExternalStore(
    android?.subscribe ?? noSubscription,
    android?.current ?? idle,
    android?.current ?? idle
  );
  return android === null ? null : { state, start: android.start };
}
