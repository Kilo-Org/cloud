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
 * the touch targets — and the fallbacks below bound a press that has no
 * incoming screen to wait for.
 */
export const TAB_SWITCH_INPUT_FALLBACK_MS = 1200;

/**
 * A press on the tab that is already focused has no incoming screen, so it
 * settles on its own timer. The tab's stack reports the end of a pop back to
 * that tab's root far earlier; this only bounds that wait.
 */
export const TAB_SWITCH_ACTIVE_TAB_SETTLE_MS = 500;

type SettleTimer = ReturnType<typeof setTimeout>;

type TabSwitchInputStore = { pendingSince: number | null; settleTimer: SettleTimer | null };

const STORE_KEY = '__kiloTabSwitchInputGate__';
const globalScope = globalThis as typeof globalThis & { [STORE_KEY]?: TabSwitchInputStore };
const store: TabSwitchInputStore = (globalScope[STORE_KEY] ??= {
  pendingSince: null,
  settleTimer: null,
});

function clearSettleTimer(): void {
  if (store.settleTimer !== null) {
    clearTimeout(store.settleTimer);
    store.settleTimer = null;
  }
}

/** Arms the window when a tab entry is pressed on the bar. */
export function markTabSwitchPending(now: number = Date.now()): void {
  clearSettleTimer();
  store.pendingSince = now;
}

/** Closes the window: the destination screen is on screen, or the switch ended. */
export function settleTabSwitchInput(): void {
  clearSettleTimer();
  store.pendingSince = null;
}

/**
 * Closes the window after `delayMs` unless the tab screen settles it first —
 * the bounded answer for a press that opens no screen.
 */
export function scheduleTabSwitchSettle(delayMs: number): void {
  clearSettleTimer();
  store.settleTimer = setTimeout(() => {
    store.settleTimer = null;
    settleTabSwitchInput();
  }, delayMs);
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
  clearSettleTimer();
  store.pendingSince = null;
}
