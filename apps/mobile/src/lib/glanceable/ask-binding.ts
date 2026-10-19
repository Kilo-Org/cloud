import type * as CloudAgentSession from './cloud-agent-session';
import type * as PendingPermission from './pending-permission';
import { getWaitingAsk, recordWaitingAsk, type WaitingAsk } from './waiting-ask';

/**
 * The bind that keeps an aggregate Approve aimed at the request its surface
 * names.
 *
 * The glanceable snapshot is privacy-minimal and the tray rows carry no request
 * id, so an aggregate surface names a session; the pending request it belongs
 * to is read from the control plane and kept beside the ask. The answer path
 * compares that record against the live request and answers only on a match,
 * the same way the session card's approval key does.
 *
 * One read per ask, not one per tray heartbeat: the publisher selects an ask on
 * every derive, and a select whose identity (session, status, status time) is
 * the recorded one keeps the binding it already has. A failed or empty read
 * leaves the ask unbound, which hides Approve; the next select after
 * `ASK_BIND_RETRY_MS` retries, so a transient control-plane failure repairs
 * itself without a timer of its own.
 */

/** Wait before a failed bind may be read again, keyed by the ask identity. */
export const ASK_BIND_RETRY_MS = 30_000;

export type AskBindingInput = { kiloSessionId: string; organizationId: string | null };

type ReadPermissionId = (input: AskBindingInput) => Promise<string | null>;

/**
 * The pending permission id for one session, as the control plane projects it.
 * A null answer means nothing is pending: the ask is no longer answerable and
 * is treated like a failed read, because neither can bind.
 *
 * Both modules are required lazily: the trpc client and the native connection
 * lifecycle belong to the app and the headless action process, not to the pure
 * suites that wire this publisher.
 */
async function readPermissionId(input: AskBindingInput): Promise<string | null> {
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  const { resolveCloudAgentSessionId } = require('./cloud-agent-session') as typeof CloudAgentSession;
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  const { resolvePendingPermissionId } = require('./pending-permission') as typeof PendingPermission;
  const cloudAgentSessionId = await resolveCloudAgentSessionId(input.kiloSessionId);
  return resolvePendingPermissionId({
    cloudAgentSessionId,
    organizationId: input.organizationId,
  });
}

/**
 * What makes two selects the same ask. `recordedAt` moves on every derive, so
 * it cannot be part of it, while the status time changes exactly when the
 * session's wait does: a binding is never carried onto a different request.
 */
function askIdentity(ask: WaitingAsk): string {
  return `${ask.kiloSessionId}|${ask.status}|${ask.statusUpdatedAt ?? ''}`;
}

// Every bind still reading, keyed by the ask it names. The settled promise is
// awaited by a headless republish, which must not end while a read it started
// could still record the binding its card draws.
const inFlight = new Map<string, Promise<void>>();
let lastFailed: { identity: string; at: number } | null = null;

const boundListeners = new Set<() => void>();

let readForTests: ReadPermissionId | null = null;
let clock: () => number = () => Date.now();

/**
 * Tell the surfaces a binding landed. They read the recorded ask at draw time,
 * so the frame they already hold has to be written again for Approve to appear.
 */
function notifyBound(): void {
  for (const listener of boundListeners) {
    try {
      listener();
    } catch {
      // A surface that cannot redraw keeps the frame it has; the next emit
      // corrects it and the binding itself is already recorded.
    }
  }
}

/** Run one surface redraw after a binding lands. Returns the unsubscribe. */
export function subscribeAskBound(listener: () => void): () => void {
  boundListeners.add(listener);
  return () => {
    boundListeners.delete(listener);
  };
}

async function bind(ask: WaitingAsk, identity: string): Promise<void> {
  let permissionId: string | null = null;
  try {
    permissionId = await (readForTests ?? readPermissionId)({
      kiloSessionId: ask.kiloSessionId,
      organizationId: ask.organizationId,
    });
  } catch {
    permissionId = null;
  }
  if (permissionId === null) {
    // Unbound, not cleared: the ask still waits, and the next select after the
    // cooldown reads again.
    lastFailed = { identity, at: clock() };
    return;
  }
  const current = getWaitingAsk();
  if (current === null || askIdentity(current) !== identity) {
    // The ask moved on while the read ran: its binding is the older surface's.
    return;
  }
  recordWaitingAsk({ ...current, boundPermissionId: permissionId });
  lastFailed = null;
  notifyBound();
}

function kickBind(ask: WaitingAsk): void {
  const identity = askIdentity(ask);
  if (inFlight.has(identity)) {
    return;
  }
  if (
    lastFailed?.identity === identity &&
    clock() - lastFailed.at < ASK_BIND_RETRY_MS
  ) {
    return;
  }
  const settled = (async () => {
    try {
      await bind(ask, identity);
    } finally {
      inFlight.delete(identity);
    }
  })();
  inFlight.set(identity, settled);
}

/**
 * The publisher's `onWaitingAskChange`: record the selected ask and keep its
 * binding. A select of the ask already recorded re-records it with the binding
 * it has; a different ask is recorded unbound and reads its request once.
 */
export function recordSelectedAsk(ask: WaitingAsk | null): void {
  if (ask === null) {
    recordWaitingAsk(null);
    return;
  }
  const current = getWaitingAsk();
  const approvable = ask.status === 'permission' && ask.isCloudAgent;
  if (current !== null && askIdentity(current) === askIdentity(ask)) {
    recordWaitingAsk({ ...ask, boundPermissionId: current.boundPermissionId });
    // Carrying a binding forward is the whole point of the identity; carrying
    // an absent one forward would leave the ask unbound forever, so the select
    // retries the read, and the cooldown keeps that to one read per window.
    if (approvable && current.boundPermissionId === null) {
      kickBind(ask);
    }
    return;
  }
  recordWaitingAsk(ask);
  if (approvable) {
    kickBind(ask);
  }
}

/**
 * Resolve once the bind for the ask currently recorded, if one is still
 * reading, has settled. A headless republish awaits this before it returns: its
 * process ends with the action, and the card it leaves behind must already offer
 * Approve for the ask it recorded.
 */
export async function whenAskBindingSettled(): Promise<void> {
  for (;;) {
    const ask = getWaitingAsk();
    const pending = ask === null ? undefined : inFlight.get(askIdentity(ask));
    if (pending === undefined) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- re-read the record: the select can change while the read runs
    await pending;
  }
}

// ── Test-only helpers ──────────────────────────────────────────────────────

/** Settle every bind still reading, whatever the record names by now. */
export async function _whenAskBindsSettledForTests(): Promise<void> {
  while (inFlight.size > 0) {
    // eslint-disable-next-line no-await-in-loop -- a superseded bind still has to settle
    await Promise.all(inFlight.values());
  }
}

export function _setAskBindingForTests(deps: {
  read?: ReadPermissionId | null;
  now?: () => number;
}): void {
  readForTests = deps.read ?? null;
  clock = deps.now ?? (() => Date.now());
}

export function _resetAskBindingForTests(): void {
  inFlight.clear();
  lastFailed = null;
  boundListeners.clear();
  readForTests = null;
  clock = () => Date.now();
}
