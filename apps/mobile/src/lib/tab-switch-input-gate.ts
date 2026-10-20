/**
 * The window a bottom-tab press opens before the destination screen is on
 * screen: the outgoing tab's native views are still the ones a touch is
 * hit-tested against, so a second tap aimed at the incoming tab's content runs
 * whatever sits at that point on the outgoing screen (explorer finding: the
 * Profile Code Reviewer row's tap reached the Home new-task button).
 *
 * The window is a timestamp read when a touch arrives rather than React state:
 * a state update would only apply with the commit whose absence is the problem.
 * The destination tab closes it from its own layout (`settleTabSwitchInput`) —
 * the route state changes earlier than that, while the outgoing views are still
 * the touch targets — and the fallback below caps a switch that never lays out.
 */
/**
 * Upper bound for a switch that never reports a layout (a tab that was already
 * focused, or one whose screen is never laid out). The incoming tab's layout
 * closes the window far earlier; this only caps the wait, and it must outlast
 * the slowest first mount measured on the emulator (about 0.8 s for Profile).
 */
export const TAB_SWITCH_INPUT_FALLBACK_MS = 1200;

type TabSwitchInputStore = { pendingSince: number | null };

const STORE_KEY = '__kiloTabSwitchInputGate__';
const globalScope = globalThis as typeof globalThis & { [STORE_KEY]?: TabSwitchInputStore };
const store: TabSwitchInputStore = (globalScope[STORE_KEY] ??= { pendingSince: null });

/** Arms the window when a tab entry is pressed on the bar. */
export function markTabSwitchPending(now: number = Date.now()): void {
  store.pendingSince = now;
}

/** Closes the window: the destination route is committed, or the switch ended. */
export function settleTabSwitchInput(): void {
  store.pendingSince = null;
}

/** Whether a touch that starts now must be kept from the tab screens. */
export function isTabSwitchPending(now: number = Date.now()): boolean {
  const pendingSince = store.pendingSince;
  if (pendingSince === null) {
    return false;
  }
  if (now - pendingSince >= TAB_SWITCH_INPUT_FALLBACK_MS) {
    store.pendingSince = null;
    return false;
  }
  return true;
}

export function __resetTabSwitchInputForTests(): void {
  store.pendingSince = null;
}
