// The native half of the app-action contract, loaded optionally.
//
// Mirrors `src/lib/native-surface-geometry.ts`: the module is looked up with
// `requireOptionalNativeModule`, so the pure and web graphs import this file
// without a native binary and without throwing at import. A binary without the
// surface (an older dev client) simply reports `isNativeAppActionsAvailable`
// false and buffered-payload registration returns nothing.

import { type NativeModule, requireOptionalNativeModule } from 'expo';

import { type AppActionResult } from './app-action-contract';

/** The JS handler native code invokes for one payload, and awaits the result of. */
export type NativeAppActionHandler = (payload: unknown) => Promise<AppActionResult>;

/** What registering the JS dispatcher yields. */
export type NativeAppActionRegistration = {
  /**
   * Runs one payload and reports its settled result to the entry point that is
   * waiting for it. The native module holds this same handler for its live
   * dispatches; the buffered replay runs through it too, so a payload that
   * arrived while the app was cold answers its caller exactly like a live one.
   */
  handle: NativeAppActionHandler;
  /**
   * The payloads that arrived before registration, verbatim in arrival order.
   * The raw buffer stays `unknown`: decoding each one into the contract is the
   * dispatcher's replay, not the bridge's.
   */
  buffered: unknown[];
};

type KiloAppActionsModule = InstanceType<typeof NativeModule> & {
  /**
   * Stores the JS handler and returns the payloads that arrived before it was
   * registered, verbatim.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- raw native buffer, normalized on the next line of this module
  registerAppActionDispatcher: (handler: NativeAppActionHandler) => Promise<unknown>;
  /**
   * Reports one payload's settled result to the native entry point waiting for
   * it. Absent where the entry points read the handler's promise directly
   * (iOS) — only the Android entry points wait on a module call.
   */
  completeAppAction?: (payload: string, result: string) => void;
};

const nativeModule = requireOptionalNativeModule<KiloAppActionsModule>('KiloAppActions');

/** Whether this binary has the native app-action surface built in. */
export const isNativeAppActionsAvailable = nativeModule !== null;

/**
 * Hand the JS dispatcher to the native module and return the handler the
 * waiting entry points are answered through, plus the payloads that arrived
 * before registration, verbatim in arrival order.
 *
 * The wrapper is what makes a result-expecting caller work: the dispatcher is
 * async, so its own return value is a promise no Android JSI call can await
 * (`expo-modules-jsi` is Apple-only). When a dispatch settles, its result is
 * reported through `completeAppAction` and the waiting entry point answers its
 * caller with the real outcome instead of a timeout.
 *
 * A missing module registers nothing and is not an error; the in-app path
 * keeps working.
 */
export async function registerNativeAppActionDispatcher(
  handler: NativeAppActionHandler
): Promise<NativeAppActionRegistration> {
  if (nativeModule === null) {
    return { handle: handler, buffered: [] };
  }
  const handle: NativeAppActionHandler = async payload => {
    const result = await handler(payload);
    reportCompletion(payload, result);
    return result;
  };
  return {
    handle,
    buffered: bufferedPayloads(await nativeModule.registerAppActionDispatcher(handle)),
  };
}

/**
 * Report one payload's settled result to a waiting native entry point. The
 * payload crosses back exactly as it arrived — the native module keyed its
 * waiter on the same value it handed over — and the result crosses as the
 * settled `AppActionResult` JSON. A reporting failure costs the caller its
 * timeout; it never changes the outcome the app produced.
 */
function reportCompletion(payload: unknown, result: AppActionResult): void {
  try {
    nativeModule?.completeAppAction?.(payloadText(payload), JSON.stringify(result));
  } catch {
    // The caller answers from its own timeout instead; the dispatch result is
    // untouched.
  }
}

/**
 * The payload key the native waiter is registered under. The Android JSI hands
 * the payload through as JSON text, so text returns verbatim; an object
 * payload crosses back as its canonical JSON.
 */
function payloadText(payload: unknown): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- bridge boundary: the two forms the native buffer carries, and the text form must return verbatim to match the waiter
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

/** The raw buffer as an arrival-order array: one payload, an array, or nothing. */
function bufferedPayloads(buffered: unknown): unknown[] {
  if (buffered === null || buffered === undefined) {
    return [];
  }
  return Array.isArray(buffered) ? buffered : [buffered];
}
