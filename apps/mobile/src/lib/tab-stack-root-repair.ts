/**
 * Rules for the root screen a tab's Stack keeps beneath every screen of that
 * tab.
 *
 * A screen pushed from a tab's root has the root beneath it, so Back returns
 * to the root and a press on the already-selected tab pops back to it. A
 * screen delivered as a FRESH navigation destination — a link that replaces the
 * focused route, or the restore a relaunch performs — can be the Stack's only
 * route instead: expo-router builds a fresh destination from the target alone,
 * and a Stack's anchor is only added when that layout's `unstable_settings` is
 * readable at the moment the destination is built. A tab Stack whose
 * destination was built without it has no screen beneath the subpage. Back
 * then leaves the tab for Home, and pressing the selected tab again cannot
 * reach the root, because the tab's press plan reads the Stack as already at
 * its root.
 *
 * What matters here is the state, not how it was reached: a tab Stack that
 * holds a subpage with no root beneath it is the defect, and every path that
 * produces one is repaired by the same rule.
 *
 * These rules name the root such a Stack is missing, and the insertion that
 * puts it back beneath the screen the reader is on.
 *
 * No React or React Native imports: every function here is unit-tested
 * directly in `tab-stack-root-repair.test.ts`.
 */

/** The route every tab Stack declares as its `unstable_settings` anchor. */
export const TAB_STACK_ROOT_ROUTE_NAME = 'index';

/** A route of a tab's Stack, as these rules read and rebuild it. */
export type TabStackRoute = {
  readonly key: string;
  readonly name: string;
  readonly params?: object;
};

/** The parts of a Stack's state these rules read. */
export type TabStackState = {
  /** The index of the focused route in `routes`. */
  readonly index: number;
  /** The routes of the Stack, bottom first. */
  readonly routes: readonly TabStackRoute[];
};

/**
 * Whether the focused screen has the tab's root beneath it.
 *
 * Only the routes BELOW the focused one count: a root above it is a screen the
 * reader moved on from, not a parent. The root itself needs no parent, and a
 * state with no routes is left alone rather than filled with a lone root.
 */
export function isTabStackRootMissing({ index, routes }: TabStackState): boolean {
  const focused = routes[index];
  if (focused === undefined || focused.name === TAB_STACK_ROOT_ROUTE_NAME) {
    return false;
  }
  return !routes
    .slice(0, Math.max(index, 0))
    .some(route => route.name === TAB_STACK_ROOT_ROUTE_NAME);
}

/** The Stack state with the tab's root inserted beneath the focused screen. */
export type TabStackRootInsertion = {
  readonly routes: TabStackRoute[];
  /** The index of the focused screen after the insertion. */
  readonly index: number;
};

/**
 * The Stack state with the tab's root inserted directly beneath the focused
 * screen, or null when the root is already there.
 *
 * The inserted root carries an EMPTY key on purpose. Expo Router derives a
 * nested navigator's state key and every route key under it from the parent
 * route key's chain (`stateKeys.createRouteKeyMinter`), so a key this module
 * invented would hand the tab's screens a chain that is not their own and the
 * navigator would fail on the next render. The reset action mints a key for a
 * route that has none, from the same sequence as every other key in the state
 * (`routers/BaseRouter.js`, `RESET`), which is the only key that fits.
 *
 * The insertion keeps every existing route, and so its key: the screen the
 * reader is on keeps its identity and its state (a half-filled form, a draft)
 * and only falls to the next index. It is a reset that leaves the focused
 * route focused, so the Android native stack never sees a screen removed and
 * another inserted in one commit (`stack-safe-replace.ts`).
 *
 * The root takes no params: it is a tab's landing screen.
 */
export function tabStackRootRepair({ index, routes }: TabStackState): TabStackRootInsertion | null {
  if (!isTabStackRootMissing({ index, routes })) {
    return null;
  }
  const focused = routes[index];
  if (focused === undefined) {
    return null;
  }
  const repaired = [...routes];
  repaired.splice(index, 0, {
    key: '',
    name: TAB_STACK_ROOT_ROUTE_NAME,
    params: {},
  });
  return { routes: repaired, index: index + 1 };
}
