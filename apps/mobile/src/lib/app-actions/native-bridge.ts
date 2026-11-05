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
   * Runs live and buffered payloads through the same JS dispatcher. The
   * returned promise preserves the settled result for native consumers.
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
   * The App Intents entity catalog, optional because a development client built
   * before the catalog shipped has none of these three. Each is absent on an
   * older binary, so every wrapper below answers "nothing happened" instead of
   * throwing.
   */
  replaceSessionCatalog?: (entries: NativeSessionCatalogEntry[]) => boolean | Promise<boolean>;
  clearSessionCatalog?: () => boolean | Promise<boolean>;
  setVisibleSession?: (sessionId: string | null) => Promise<void>;
};

/** One session the App Intents entity catalog offers. Mirrors the Swift record. */
export type NativeSessionCatalogEntry = { id: string; title: string };

const nativeModule = requireOptionalNativeModule<KiloAppActionsModule>('KiloAppActions');

/** Whether this binary has the native app-action surface built in. */
export const isNativeAppActionsAvailable = nativeModule !== null;

/** Whether this binary can offer sessions to Siri and Shortcuts at all. */
export const isNativeSessionCatalogAvailable =
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- boundary: a development client built before the catalog shipped has no method at all, so the shape is the only thing to test
  typeof nativeModule?.replaceSessionCatalog === 'function';

/**
 * Replaces the whole entity catalog. True means the device stored a different
 * list, so a run that re-published the same titles reports no change.
 */
export async function replaceNativeSessionCatalog(
  entries: readonly NativeSessionCatalogEntry[]
): Promise<boolean> {
  const replace = nativeModule?.replaceSessionCatalog;
  if (replace === undefined) {
    return false;
  }
  const stored = await replace(entries.map(entry => ({ id: entry.id, title: entry.title })));
  return stored;
}

/** Wipes the entity catalog. True means there was something to wipe. */
export async function clearNativeSessionCatalog(): Promise<boolean> {
  const clear = nativeModule?.clearSessionCatalog;
  if (clear === undefined) {
    return false;
  }
  const cleared = await clear();
  return cleared;
}

/**
 * Publishes the session the app is showing, or clears it with `null`.
 *
 * Calls are chained, so a blur and the next focus publish in the order the app
 * produced them: the on-screen entity must never end up naming the session the
 * person just left. The chain swallows a rejection so one failed publish cannot
 * block the next, and the returned promise still rejects to the caller that can
 * report it.
 */
let visibleSessionQueue: Promise<void> = Promise.resolve();

export async function setNativeVisibleSession(sessionId: string | null): Promise<void> {
  const publish = nativeModule?.setVisibleSession;
  if (publish === undefined) {
    return;
  }
  const previous = visibleSessionQueue;
  const run = (async () => {
    try {
      await previous;
    } catch {
      // The predecessor's rejection is its caller's to report; it must not
      // stall the publish that follows it.
    }
    await publish(sessionId);
  })();
  visibleSessionQueue = (async () => {
    try {
      await run;
    } catch {
      // Swallowed only for the chain, so the next publish still runs.
    }
  })();
  await run;
}

/**
 * Register the shared handler and return buffered payloads in arrival order.
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
