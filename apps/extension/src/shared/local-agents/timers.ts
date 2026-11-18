/* eslint-disable promise/prefer-await-to-callbacks -- timer callbacks are synchronous by contract */
import type { LocalAgentTimers } from './transport-types';

/*
 * The timer handles differ by context: Chrome's service worker and Firefox's
 * background page return opaque ids, and @types/node types the same globals as
 * `Timeout` objects. The transport layer only needs a number, so this adapter
 * owns the mapping and the platform type stays here.
 */

let nextHandle = 0;
const clearers = new Map<number, () => void>();

export const localAgentTimers: LocalAgentTimers = {
  clearTimeout: (handle: number) => {
    const clear = clearers.get(handle);

    if (clear === undefined) {
      return;
    }

    clearers.delete(handle);
    clear();
  },
  setTimeout: (callback: () => void, delayMs: number) => {
    nextHandle += 1;
    const handle = nextHandle;
    const timer = globalThis.setTimeout(() => {
      clearers.delete(handle);
      callback();
    }, delayMs);

    clearers.set(handle, () => {
      globalThis.clearTimeout(timer);
    });

    return handle;
  },
};
