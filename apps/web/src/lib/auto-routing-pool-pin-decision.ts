import {
  customRouterEntryKey,
  type CustomRouterEntry,
  type CustomRouterPoolPinsResponse,
  type CustomRouterServingPin,
} from '@kilocode/auto-routing-contracts';

function confirmedAtOf(pin: CustomRouterServingPin | undefined): number {
  // A pin written before confirmations were recorded is the oldest, so any confirmation beats it.
  const parsed = pin?.confirmedAt ? Date.parse(pin.confirmedAt) : Number.NEGATIVE_INFINITY;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export type ServingPinOutcome = {
  entries: CustomRouterEntry[];
  applied: CustomRouterPoolPinsResponse['applied'];
  skipped: CustomRouterPoolPinsResponse['skipped'];
};

/**
 * The whole pin decision, pure so the settlement's ordering rules are testable without a database.
 * Pins are server-authored: clients cannot send one, and pool edits preserve them by entry key.
 *
 * Rules:
 * - The saved pool must still be the version the request was confirmed for. A mismatch pins
 *   nothing: the owner edited the pool (or removed and restored an entry) after confirming, so no
 *   target measured for that state may become the pin.
 * - Pins order by `confirmedAt`, never by completion time, so a slow older request cannot
 *   overwrite a pin a newer quote already wrote. Replaying the same request is idempotent, and an
 *   entry the pool no longer has stays unpinned.
 * - Only an unlinked gateway entry can pin: a `measuredAs` entry reuses a platform measurement and
 *   never dispatches its own target.
 */
export function decideServingPins(input: {
  entries: readonly CustomRouterEntry[];
  aliases: readonly { model: string; target: string }[];
  poolUnchanged: boolean;
  requestId: string;
  confirmedAt: string;
  pinnedAt: string;
}): ServingPinOutcome {
  const { entries: current, aliases, poolUnchanged, requestId, confirmedAt, pinnedAt } = input;
  const applied: ServingPinOutcome['applied'] = [];
  const skipped: ServingPinOutcome['skipped'] = [];
  const entries = [...current];

  if (!poolUnchanged) {
    for (const alias of aliases) skipped.push({ model: alias.model, reason: 'pool_changed' });
    return { entries, applied, skipped };
  }

  const indexesByKey = new Map(
    current.map((entry, index) => [customRouterEntryKey(entry), index] as const)
  );
  for (const alias of aliases) {
    const index = indexesByKey.get(customRouterEntryKey({ kind: 'gateway', model: alias.model }));
    const entry = index === undefined ? undefined : entries[index];
    if (index === undefined || entry === undefined) {
      skipped.push({ model: alias.model, reason: 'entry_missing' });
      continue;
    }
    if (entry.kind !== 'gateway') {
      skipped.push({ model: alias.model, reason: 'not_a_gateway_entry' });
      continue;
    }
    if (entry.measuredAs !== undefined) {
      skipped.push({ model: alias.model, reason: 'link_applies' });
      continue;
    }
    if (entry.servingPin?.model === alias.target) {
      // The same target is already pinned, including a replay of this very request.
      skipped.push({ model: alias.model, reason: 'unchanged' });
      continue;
    }
    if (confirmedAtOf(entry.servingPin) > Date.parse(confirmedAt)) {
      skipped.push({ model: alias.model, reason: 'superseded' });
      continue;
    }
    const pin: CustomRouterServingPin = {
      model: alias.target,
      pinnedAt,
      requestId,
      confirmedAt,
    };
    entries[index] = { ...entry, servingPin: pin };
    applied.push({ model: alias.model, target: alias.target, pinnedAt });
  }
  return { entries, applied, skipped };
}
