/**
 * The store's subscriber fan-out, split out of `gguf-downloads.ts` so the store
 * keeps the download's lifecycle and this module keeps what one published
 * snapshot may do to the views that read it.
 */

import { captureTelemetry } from '../telemetry/error-sink';

/** Where a view that threw while rendering a published snapshot is filed. */
const LISTENER_FAILURE = {
  'error.subsystem': 'gguf-downloads',
  'error.operation': 'publish_listener',
} as const;

/**
 * Tells every subscriber the snapshot changed. A view that throws while
 * rendering must not fail a download the saved list already names, and must not
 * keep the other views from hearing about it, so each call is contained; the
 * throw is still reported, because a rendering defect has to be visible.
 */
export function notifySubscribers(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      captureTelemetry({ error, level: 'error', tags: LISTENER_FAILURE });
    }
  }
}
