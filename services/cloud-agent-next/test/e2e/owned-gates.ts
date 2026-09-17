/**
 * Owned-gate release policy shared by the queue and continuity definitions.
 *
 * A gate tag is owned for the whole scenario. The scenario releases the tags it
 * needs gone in its own body; whatever it still owns when the body returns is
 * released here. A tag the fake no longer holds (a 404 on release) is already
 * gone, but any other failure leaves the scenario failed rather than leaking a
 * parked waiter into the shared single fake-LLM instance.
 *
 * This module owns that policy for both families so the two copies cannot drift:
 * the queue definitions release through it and the continuity definition wraps
 * its body with it.
 */

import { releaseGate, type DriverConfig } from './client.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';

/**
 * Cleanup runs after the scenario deadline is spent, so it needs its own
 * budget. A release is a small control-plane call; if the fake's control route
 * wedges, aborting turns it into a reported leak (fail closed) rather than
 * leaving cleanup pending forever.
 */
const GATE_RELEASE_TIMEOUT_MS = 15_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A release 404 means the fake never registered (or already dropped) the tag,
 * so nothing is parked under it. Treat that as released, not as a leak.
 */
export function isAlreadyReleased(error: unknown): boolean {
  return /failed: 404\b|Not Found/.test(errorMessage(error));
}

/**
 * Release every tag this run still owns and report the ones that could not be
 * released. A scenario result is failed rather than returned when a tag is
 * left parked on the shared fake LLM.
 */
export async function releaseOwnedGates(
  config: DriverConfig,
  owned: Set<string>,
  result: LifecycleResult
): Promise<LifecycleResult> {
  const failures: string[] = [];
  for (const tag of [...owned]) {
    try {
      await releaseGate(config.fakeLlmUrl, tag, AbortSignal.timeout(GATE_RELEASE_TIMEOUT_MS));
      owned.delete(tag);
    } catch (error) {
      if (isAlreadyReleased(error)) owned.delete(tag);
      else failures.push(`${tag}: ${errorMessage(error)}`);
    }
  }
  if (owned.size === 0 && failures.length === 0) return result;
  return {
    ...result,
    ok: false,
    message: `${result.message}; ownedGateLeak=${failures.join(' | ') || [...owned].join(',')}`,
  };
}

/**
 * Run a gate-owning body and then release every tag it still owns. The release
 * runs in a `finally`, so a body that throws still releases its parked gates.
 * `name` labels the result only when the body throws before producing one.
 */
export async function withOwnedGates(
  name: string,
  args: LifecycleArgs,
  body: (owned: Set<string>) => Promise<LifecycleResult>
): Promise<LifecycleResult> {
  const owned = new Set<string>();
  let result: LifecycleResult = {
    name,
    conversation: args.conversation,
    ok: false,
    message: 'scenario body did not return a result',
    events: [],
    durationMs: 0,
  };
  try {
    result = await body(owned);
  } finally {
    result = await releaseOwnedGates(args.config, owned, result);
  }
  return result;
}
