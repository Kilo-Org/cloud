/**
 * Pure fail-closed telemetry gate. No React, no SDK imports.
 *
 * `generation` scopes SDK payloads to the account that produced them —
 * an unflushed queue from account A cannot transmit under account B.
 * `epoch` guards async teardown against a fast off-then-on race.
 *
 * With `decision === undefined` both allow-checks return `false`.
 */
type TelemetryDecision = {
  accountId: string;
  optional: boolean;
};

/** Notified when the account-scoping `generation` changes. */
export type TelemetryGenerationListener = () => void;

let decision: TelemetryDecision | undefined = undefined;
let generation = 0;
let epoch = 0;
const generationListeners = new Set<TelemetryGenerationListener>();

/** Notify every listener; the gate write has already happened, so a throwing
 *  listener must not break the other listeners or the gate. */
function notifyGenerationListeners(): void {
  for (const listener of generationListeners) {
    try {
      listener();
    } catch {
      // Telemetry must never throw into app code.
    }
  }
}

/** Subscribe to account-generation changes. Returns an unsubscribe function.
 *
 *  A listener is notified only when `generation` changes: an account change in
 *  `setTelemetryDecision`, or any `clearTelemetryDecision`. An epoch-only
 *  change (same account, `optional` flipped) does not notify, because it cannot
 *  change which account a queued payload belongs to. `resetTelemetryControllerForTests`
 *  does not notify either: it resets the controller outside any account
 *  transition, and no product subscriber is mounted while it runs. */
export function subscribeToTelemetryGeneration(listener: TelemetryGenerationListener): () => void {
  generationListeners.add(listener);
  return () => {
    generationListeners.delete(listener);
  };
}

/** Write a decision for the given account. Increments `generation` only on
 *  an account change. Always increments `epoch`. */
export function setTelemetryDecision(accountId: string, optional: boolean): void {
  const accountChanged = decision !== undefined && decision.accountId !== accountId;
  if (accountChanged) {
    generation += 1;
  }
  epoch += 1;
  decision = { accountId, optional };
  if (accountChanged) {
    notifyGenerationListeners();
  }
}

/** Clear the decision. Increments `generation` and `epoch`, then closes every gate. */
export function clearTelemetryDecision(): void {
  generation += 1;
  epoch += 1;
  decision = undefined;
  notifyGenerationListeners();
}

/** Mandatory telemetry is allowed when any decision exists. */
export function allowsMandatory(): boolean {
  return decision !== undefined;
}

/** Optional telemetry is allowed only when the decision explicitly opted in. */
export function allowsOptional(): boolean {
  return decision?.optional === true;
}

export function currentGeneration(): number {
  return generation;
}

export function currentEpoch(): number {
  return epoch;
}

export function currentAccountId(): string | undefined {
  return decision?.accountId;
}

/** Reset every module-level variable. For tests only. */
export function resetTelemetryControllerForTests(): void {
  decision = undefined;
  generation = 0;
  epoch = 0;
}
