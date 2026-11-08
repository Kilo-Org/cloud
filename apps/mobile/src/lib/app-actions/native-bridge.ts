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
   * before the catalog shipped has none of these. Each is absent on an older
   * binary, so every wrapper below answers "nothing happened" instead of
   * throwing.
   */
  replaceSessionCatalog?: (entries: NativeSessionCatalogEntry[]) => boolean | Promise<boolean>;
  clearSessionCatalog?: () => boolean | Promise<boolean>;
  /**
   * The app lock's terms for the catalog: whether it is on, and how long the
   * app may stay in the background before the entity queries stop answering,
   * in milliseconds.
   */
  setSessionCatalogLock?: (enabled: boolean, intervalMs: number) => void;
  /**
   * Whether this launch is showing unlocked content. The store starts closed,
   * so this is the call that lets an App Intents answer use the titles.
   */
  setSessionCatalogVisible?: (visible: boolean) => void;
  setVisibleSession?: (sessionId: string | null) => Promise<void>;
};

/** One session the App Intents entity catalog offers. Mirrors the Swift record. */
type NativeSessionCatalogEntry = { id: string; title: string };

const nativeModule = requireOptionalNativeModule<KiloAppActionsModule>('KiloAppActions');

/** Whether this binary has the native app-action surface built in. */
export const isNativeAppActionsAvailable = nativeModule !== null;

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
 * Hands the native catalog the app lock's terms: whether the lock is on, and
 * how long the app may sit in the background before the entity queries stop
 * answering.
 *
 * The store keeps the background instant itself, because the App Intents answer
 * from a launched process where no JavaScript runs, and the lock surface only
 * covers the foreground. A binary built before this call exists keeps
 * answering: it has no window to keep, and the in-app lock's own clears are all
 * it had.
 */
export function setNativeSessionCatalogLock(enabled: boolean, intervalMs: number): void {
  const set = nativeModule?.setSessionCatalogLock;
  if (set === undefined) {
    return;
  }
  // The native setter is synchronous: it stores two values and starts the
  // lifecycle observers on its first call.
  set(enabled, intervalMs);
}

/**
 * Tells the native catalog whether this launch is showing unlocked content.
 *
 * The store starts closed, so a launch the system starts to answer an App
 * Intent gets nothing until the app says it is unlocked — and a lock-enabled
 * device therefore keeps its titles to itself while the lock surface stands. A
 * binary built before this call exists keeps answering, which is what it always
 * did.
 */
export function setNativeSessionCatalogVisible(visible: boolean): void {
  const set = nativeModule?.setSessionCatalogVisible;
  if (set === undefined) {
    return;
  }
  set(visible);
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
