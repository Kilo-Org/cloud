import { Effect } from 'effect';
import { useSyncExternalStore } from 'react';

import { i18n } from '@/i18n';

/** One confirmation the mounted host has still to show. */
export type SettingsConfirmRequest = {
  id: number;
  /** The change the person is asked to allow, already localized by the tool. */
  summary: string;
  /**
   * The tool call behind the request was interrupted: the request must never be
   * answered. The head keeps its place until the host has dismissed the sheet
   * it presented and reports it; a request still queued behind the head was
   * never drawn and leaves the queue outright instead.
   */
  withdrawn: boolean;
};

// The module-level store. A request is removed when it is answered or forgotten
// after its withdrawal, so the head keeps its identity while nothing changes —
// the `useSyncExternalStore` identity contract.
let requests: readonly SettingsConfirmRequest[] = [];
let nextRequestId = 1;
// Whether a host is mounted to draw the requests. Without one a destructive
// change is refused instead of waiting forever.
let hostMounted = false;
const listeners = new Set<() => void>();
// The one resolve each pending request is waiting on, keyed by its id.
const settleCallbacks = new Map<number, (confirmed: boolean) => void>();

/** `useSyncExternalStore` getSnapshot. Stable while the head is unchanged. */
export function getSettingsConfirmRequest(): SettingsConfirmRequest | undefined {
  return requests[0];
}

/**
 * `useSyncExternalStore` subscribe: registers a listener with the store and
 * removes its handle. The mounted host subscribes through
 * `useSettingsConfirmRequest`. A test registers one to settle a request from
 * inside the publish window.
 */
export function subscribeSettingsConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The oldest request still waiting for an answer, or none. */
export function useSettingsConfirmRequest(): SettingsConfirmRequest | undefined {
  return useSyncExternalStore(subscribeSettingsConfirm, getSettingsConfirmRequest);
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Records whether a host is mounted; the host owns the flag from its effect. */
export function setSettingsConfirmHostMounted(mounted: boolean): void {
  hostMounted = mounted;
}

/**
 * Enqueues a request and returns its id. The host draws requests one at a
 * time, oldest first, so a second request waits behind the first.
 *
 * `answer` is the resolver for the one caller whose exact request this is; it
 * is registered before the request is published, so a store listener that
 * answers during the publish cannot fall into the gap between "the request is
 * visible" and "the request can be answered" — the gap that would leave a tool
 * call waiting forever.
 */
export function requestSettingsConfirmChange(
  summary: string,
  answer: (confirmed: boolean) => void
): number {
  const id = nextRequestId;
  nextRequestId += 1;
  settleCallbacks.set(id, answer);
  requests = [...requests, { id, summary, withdrawn: false }];
  notify();
  return id;
}

function settle(id: number, confirmed: boolean): void {
  const settleRequest = settleCallbacks.get(id);
  if (settleRequest === undefined) {
    return;
  }
  settleCallbacks.delete(id);
  settleRequest(confirmed);
}

/**
 * Delivers the answer a sheet report carries for the request with this id. A
 * request still waiting is settled once and removed, so a second press on the
 * still-rendered sheet cannot answer twice. A delivered answer for a withdrawn
 * request removes it from the queue instead: the closure a press captured
 * before the withdrawal still reports through the dialog after the fact, and
 * no sheet is left to dismiss the withdrawn entry again — an answer that
 * nothing can settle must not pin the queue behind itself.
 */
export function answerSettingsConfirm(id: number, confirmed: boolean): void {
  const request = requests.find(item => item.id === id);
  if (request === undefined) {
    return;
  }
  if (request.withdrawn) {
    forgetSettingsConfirm(id);
    return;
  }
  requests = requests.filter(item => item.id !== id);
  notify();
  // Only settle's lookup can fire the resolver, so a request is answered once
  // however the press races the dismissal report.
  settle(id, confirmed);
}

/**
 * Marks the request withdrawn for an interrupted tool call: its resolver is
 * dropped, so it can never be answered. Only the head keeps its queue place —
 * its sheet is presented, and it goes out through a reported dismissal the
 * host answers with `forgetSettingsConfirm`. A request still waiting behind
 * the head was never drawn, and the host renders only the head, so keeping it
 * would present a phantom sheet on mount just to dismiss it; it is removed
 * from the queue outright instead.
 */
function withdrawSettingsConfirm(id: number): void {
  settleCallbacks.delete(id);
  const request = requests.find(item => item.id === id);
  if (request === undefined) {
    return;
  }
  // The head's place is kept for its reported dismissal; anything still queued
  // behind it was never drawn and leaves outright.
  requests =
    requests[0] === request
      ? requests.map(item => (item.id === id ? { ...item, withdrawn: true } : item))
      : requests.filter(item => item.id !== id);
  notify();
}

/**
 * Removes the request with this id from the queue. The host calls it after a
 * withdrawn request's sheet reported its dismissal; the head changes identity,
 * so a new request waiting behind it can be drawn.
 */
export function forgetSettingsConfirm(id: number): void {
  if (!requests.some(item => item.id === id)) {
    return;
  }
  requests = requests.filter(item => item.id !== id);
  notify();
}

/**
 * Settles everything still waiting. The host calls this as it tears down, so
 * a tool call never waits on a confirm that can no longer appear.
 */
export function settleAllSettingsConfirms(confirmed: boolean): void {
  const pending = [...settleCallbacks.values()];
  settleCallbacks.clear();
  requests = [];
  notify();
  for (const settleRequest of pending) {
    settleRequest(confirmed);
  }
}

/**
 * The settings where one direction of the change needs the person's ok, and the
 * dialog body that asks for it. The table is the single source of truth for the
 * guarded set: the catalog entries read it through `guardedChangeSummary`, and
 * the test suite iterates the same names.
 */
type GuardedChange = Readonly<{
  name: string;
  /** The boolean value that asks first; the opposite value is written at once. */
  direction: 'on' | 'off';
  summaryKey: string;
}>;

const GUARDED_CHANGES = [
  {
    name: 'notifications.spendAlerts',
    direction: 'off',
    summaryKey: 'settingsTools.guarded.spendAlertsOff',
  },
  {
    name: 'notifications.balanceAlerts',
    direction: 'off',
    summaryKey: 'settingsTools.guarded.balanceAlertsOff',
  },
  {
    name: 'notifications.securityFindings',
    direction: 'off',
    summaryKey: 'settingsTools.guarded.securityFindingsOff',
  },
  {
    name: 'hideBalance',
    direction: 'on',
    summaryKey: 'settingsTools.guarded.hideBalanceOn',
  },
] as const satisfies readonly GuardedChange[];

/**
 * The dialog body to show before writing this change, or nothing when the
 * change does not need one. Value-triggered: only the guarded direction of a
 * guarded setting returns a summary.
 *
 * The body is the reader's own language throughout: the translated sentence
 * carries the ask, and the setting name and value follow as the same
 * `name = value` tokens the tool call used, so a reader can match the sheet to
 * the change without an English sentence inside translated copy.
 */
export function guardedChangeSummary(name: string, value: unknown): string | undefined {
  const guarded = GUARDED_CHANGES.find(change => change.name === name);
  if (guarded === undefined) {
    return undefined;
  }
  const guardedValue = guarded.direction === 'on';
  if (value !== guardedValue) {
    return undefined;
  }
  return `${i18n.t(guarded.summaryKey)} (${name} = ${String(value)})`;
}

/**
 * Asks the person to confirm a settings change that needs their word. Resolves
 * true when they choose Save and false on Cancel, on Android Back, on a
 * backdrop tap, when the host tears down, and when no host is mounted.
 *
 * Used for the destructive trusted-host list, and for the value-triggered
 * guarded settings named in `GUARDED_CHANGES` above: an agent's tool call never
 * reaches the store until this resolves true, so those settings never change in
 * silence.
 */
export function confirmSettingChange(summary: string): Effect.Effect<boolean> {
  return Effect.callback<boolean>(resume => {
    if (!hostMounted) {
      resume(Effect.succeed(false));
      return Effect.void;
    }
    // Publish and register in one step: the resolver is already in place when
    // the store's listeners hear about the request, so an answer given during
    // the publish reaches the waiting tool call.
    const id = requestSettingsConfirmChange(summary, confirmed => {
      resume(Effect.succeed(confirmed));
    });
    return Effect.sync(() => {
      withdrawSettingsConfirm(id);
    });
  });
}
