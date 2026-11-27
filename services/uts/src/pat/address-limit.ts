/**
 * At most 20 uncached PAT lookups per second per client per isolate (design 3, 7), as the verifier
 * library counts them. A client is an IPv4 address or an IPv6 /64 (`clientLimitKey`). The probe
 * route caches nothing, so every request it lets through is one lookup. The bookkeeping holds at
 * most 10,000 clients; the oldest window goes first. Plain data only, per isolate.
 */

export const LOOKUPS_PER_SECOND_PER_ADDRESS = 20;
const WINDOW_MS = 1000;
const MAX_TRACKED_ADDRESSES = 10_000;

export type AddressWindows = Map<string, { startedAt: number; count: number }>;

/** True when one more lookup from `address` fits its current one-second window. */
export function admitLookup(windows: AddressWindows, address: string, now: number): boolean {
  const held = windows.get(address);
  if (held !== undefined && now - held.startedAt < WINDOW_MS) {
    if (held.count >= LOOKUPS_PER_SECOND_PER_ADDRESS) return false;
    held.count += 1;
    return true;
  }
  // A new window moves the address to the end, so the first entry is always the oldest window.
  windows.delete(address);
  windows.set(address, { startedAt: now, count: 1 });
  if (windows.size > MAX_TRACKED_ADDRESSES) {
    const oldest = windows.keys().next();
    if (oldest.done !== true) windows.delete(oldest.value);
  }
  return true;
}
