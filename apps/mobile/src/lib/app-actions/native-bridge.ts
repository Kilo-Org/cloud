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
   * Runs one payload through the JS dispatcher. The native module holds this
   * same handler for its live dispatches; the buffered replay runs through it
   * too, so a payload that arrived while the app was cold runs exactly like a
   * live one. Its result is the app's own: nothing travels back through the
   * entry point that started it.
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
   * registered, verbatim. Synchronous on both platforms: the native side has
   * to take the handler on the JS thread.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- raw native buffer, normalized on the next line of this module
  registerAppActionDispatcher: (handler: NativeAppActionHandler) => unknown;
  /**
   * Whether a `StartAgent` this platform's entry point delivers asks the user
   * first. Android declares it; iOS does not, because its intents run with no
   * screen.
   */
  startAgentNeedsConfirmation?: () => boolean;
};

const nativeModule = requireOptionalNativeModule<KiloAppActionsModule>('KiloAppActions');

/** Whether this binary has the native app-action surface built in. */
export const isNativeAppActionsAvailable = nativeModule !== null;

/**
 * Whether this binary's entry point asks the user before a `StartAgent` starts:
 * the platform's own answer, and `false` for a binary that does not declare one.
 */
export function startAgentNeedsConfirmation(): boolean {
  return nativeModule?.startAgentNeedsConfirmation?.() === true;
}

/**
 * Hand the JS dispatcher to the native module and return the handler it drives
 * plus the payloads that arrived before registration, verbatim in arrival
 * order. The handler is the dispatcher's own: it returns the settled
 * `AppActionResult` for the run, and the app is what shows that outcome.
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
  return {
    handle: handler,
    buffered: bufferedPayloads(await nativeModule.registerAppActionDispatcher(handler)),
  };
}

/** The raw buffer as an arrival-order array: one payload, an array, or nothing. */
function bufferedPayloads(buffered: unknown): unknown[] {
  if (buffered === null || buffered === undefined) {
    return [];
  }
  return Array.isArray(buffered) ? buffered : [buffered];
}
