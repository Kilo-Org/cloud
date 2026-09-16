// The native half of the app-action contract, loaded optionally.
//
// Mirrors `src/lib/native-surface-geometry.ts`: the module is looked up with
// `requireOptionalNativeModule`, so the pure and web graphs import this file
// without a native binary and without throwing at import. A binary without the
// surface (an older dev client) simply reports `isNativeAppActionsAvailable`
// false and buffered-payload registration returns nothing.

import { type NativeModule, requireOptionalNativeModule } from 'expo';

import {
  type AppActionRequest,
  type AppActionResult,
  parseAppActionPayload,
} from './app-action-contract';

/** The JS handler native code invokes for one payload, and awaits the result of. */
export type NativeAppActionHandler = (payload: unknown) => Promise<AppActionResult>;

type KiloAppActionsModule = InstanceType<typeof NativeModule> & {
  /**
   * Stores the JS handler and returns the payloads that arrived before it was
   * registered, verbatim — `parseBufferedPayloads` is the boundary that decodes
   * them into the contract, so the raw buffer stays `unknown` here.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- raw native buffer, decoded on the next line of this module
  registerAppActionDispatcher: (handler: NativeAppActionHandler) => Promise<unknown>;
};

const nativeModule = requireOptionalNativeModule<KiloAppActionsModule>('KiloAppActions');

/** Whether this binary has the native app-action surface built in. */
export const isNativeAppActionsAvailable = nativeModule !== null;

/**
 * Hand the JS dispatcher to the native module and return the payloads it
 * buffered, parsed in arrival order.
 *
 * A payload the contract rejects is dropped rather than failing registration:
 * the buffer is a delivery buffer, not a validation surface. A missing module
 * returns nothing and leaves the in-app path working.
 */
export async function registerNativeAppActionDispatcher(
  handler: NativeAppActionHandler
): Promise<AppActionRequest[]> {
  if (nativeModule === null) {
    return [];
  }
  return parseBufferedPayloads(await nativeModule.registerAppActionDispatcher(handler));
}

/** Parse whatever the native buffer held: one payload, an array, or nothing. */
function parseBufferedPayloads(buffered: unknown): AppActionRequest[] {
  if (buffered === null || buffered === undefined) {
    return [];
  }
  const payloads = Array.isArray(buffered) ? buffered : [buffered];
  const requests: AppActionRequest[] = [];
  for (const payload of payloads) {
    const request = parseAppActionPayload(payload);
    if (request !== null) {
      requests.push(request);
    }
  }
  return requests;
}
