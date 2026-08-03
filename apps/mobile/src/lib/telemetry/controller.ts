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

let decision: TelemetryDecision | undefined;
let generation = 0;
let epoch = 0;

/** Write a decision for the given account. Increments `generation` only on
 *  an account change. Always increments `epoch`. */
export function setTelemetryDecision(accountId: string, optional: boolean): void {
  if (decision !== undefined && decision.accountId !== accountId) {
    generation += 1;
  }
  epoch += 1;
  decision = { accountId, optional };
}

/** Clear the decision. Increments `generation` and `epoch`, then closes every gate. */
export function clearTelemetryDecision(): void {
  generation += 1;
  epoch += 1;
  decision = undefined;
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
