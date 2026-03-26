import { DEFAULT_FLY_REGION } from '../config';

/** Meta regions used as the fallback when only one named region would remain. */
const META_REGION_FALLBACK = 'eu,us';

/** KV key used to store the runtime region configuration. */
export const FLY_REGIONS_KV_KEY = 'fly-regions';

/** Fly geographic aliases that expand server-side — these should NOT be shuffled. */
const FLY_META_REGIONS = new Set(['eu', 'us']);

/** All valid specific Fly regions (from `fly platform regions`). */
export const FLY_SPECIFIC_REGIONS = [
  // Africa
  'jnb',
  // Asia Pacific
  'bom',
  'sin',
  'syd',
  'nrt',
  // Europe
  'ams',
  'fra',
  'lhr',
  'cdg',
  'arn',
  // North America
  'iad',
  'ord',
  'dfw',
  'lax',
  'sjc',
  'ewr',
  'yyz',
  // South America
  'gru',
] as const;

/** All valid region codes (meta + specific). */
export const ALL_VALID_REGIONS = ['eu', 'us', ...FLY_SPECIFIC_REGIONS] as const;

/** Split a comma-separated region string into an array. */
export function parseRegions(regionList: string): string[] {
  return regionList
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);
}

/** Fisher-Yates shuffle (in-place). Returns the same array for chaining. */
export function shuffleRegions(regions: string[]): string[] {
  for (let i = regions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = regions[i];
    regions[i] = regions[j];
    regions[j] = tmp;
  }
  return regions;
}

/**
 * Exclude a failed region from the candidate list. With 3+ distinct regions
 * the failed region is removed entirely (including duplicates). With only 2
 * distinct regions the failed region is moved to the end so we still have a
 * fallback.
 *
 * E.g. deprioritizeRegion(['dfw', 'yyz', 'cdg'], 'dfw') → ['yyz', 'cdg']
 *      deprioritizeRegion(['dfw', 'dfw', 'ord'], 'dfw') → ['ord']
 *      deprioritizeRegion(['dfw', 'yyz'], 'dfw')        → ['yyz', 'dfw']
 */
export function deprioritizeRegion(regions: string[], failedRegion: string | null): string[] {
  if (!failedRegion) return regions;
  const without = regions.filter(r => r !== failedRegion);
  if (without.length === regions.length) return regions; // failedRegion wasn't in the list
  if (without.length === 0) return regions; // only region — keep it as sole fallback
  const distinctCount = new Set(regions).size;
  if (distinctCount <= 2) return [...without, failedRegion];
  return without;
}

/** Returns true if a region code is a Fly geographic alias (not a specific region). */
export function isMetaRegion(region: string): boolean {
  return FLY_META_REGIONS.has(region.toLowerCase());
}

/**
 * Conditionally shuffle regions: specific region codes (e.g. dfw, ord) are shuffled
 * for load distribution, while meta-regions (eu, us) are left in declared order
 * since Fly handles distribution internally.
 *
 * If ANY region in the list is specific, the entire list is shuffled.
 * Duplicates are intentional — they bias the shuffle probability.
 */
export function prepareRegions(regions: string[]): string[] {
  const hasSpecific = regions.some(r => !isMetaRegion(r));
  return hasSpecific ? shuffleRegions([...regions]) : regions;
}

/**
 * Resolve the region list from KV (runtime-configurable), falling back to the
 * FLY_REGION env var, then the hardcoded default. Applies conditional shuffling.
 *
 * A KV read failure is swallowed so a transient outage doesn't block provisioning.
 */
export async function resolveRegions(
  kv: KVNamespace,
  envFlyRegion: string | undefined
): Promise<string[]> {
  let kvValue: string | null = null;
  try {
    kvValue = await kv.get(FLY_REGIONS_KV_KEY);
  } catch {
    // KV read failed — fall back to env/default
  }
  const raw = kvValue ?? envFlyRegion ?? DEFAULT_FLY_REGION;
  return prepareRegions(parseRegions(raw));
}

/**
 * Result of attempting to remove a failed region from the KV region list.
 */
export type RemoveRegionResult =
  | { action: 'skipped_meta'; reason: string }
  | { action: 'removed'; removedRegion: string; newRegions: string[]; newRaw: string }
  | { action: 'reverted_to_meta'; removedRegion: string; newRaw: string }
  | { action: 'not_in_list'; reason: string };

/**
 * Remove a failed named region from the KV region list after a capacity error.
 *
 * Rules:
 * - If the current KV list consists entirely of meta-regions (eu, us), nothing
 *   is done — Fly handles distribution internally.
 * - If the failed region is not in the list, nothing is done.
 * - If removing the region would leave only one distinct named region, the KV
 *   value is replaced with the meta-region fallback ("eu,us") plus the last
 *   remaining named region as a hint prefix: "TheLastRegion,eu,us".
 * - Otherwise the region is removed from the list and KV is updated.
 *
 * KV write failures are swallowed so a transient outage never blocks provisioning.
 */
export async function removeRegionFromKv(
  kv: KVNamespace,
  envFlyRegion: string | undefined,
  failedRegion: string
): Promise<RemoveRegionResult> {
  let kvValue: string | null = null;
  try {
    kvValue = await kv.get(FLY_REGIONS_KV_KEY);
  } catch {
    // KV read failed — treat as empty; fall back to env/default
  }
  const raw = kvValue ?? envFlyRegion ?? DEFAULT_FLY_REGION;
  const regions = parseRegions(raw);

  // If all regions are meta-regions, nothing to do.
  if (regions.every(r => isMetaRegion(r))) {
    return { action: 'skipped_meta', reason: 'all regions are meta-regions' };
  }

  // If the failed region is not present in the list, nothing to do.
  if (!regions.includes(failedRegion)) {
    return { action: 'not_in_list', reason: `${failedRegion} not in current region list` };
  }

  const remaining = regions.filter(r => r !== failedRegion);
  const distinctRemaining = [...new Set(remaining.filter(r => !isMetaRegion(r)))];

  if (distinctRemaining.length <= 1) {
    // Only one (or zero) named region would remain — revert to meta fallback.
    // Prefix with the last remaining named region as a breadcrumb (if any).
    const lastRegion = distinctRemaining[0];
    const newRaw = lastRegion ? `${lastRegion},${META_REGION_FALLBACK}` : META_REGION_FALLBACK;
    try {
      await kv.put(FLY_REGIONS_KV_KEY, newRaw);
    } catch {
      // Best-effort
    }
    return { action: 'reverted_to_meta', removedRegion: failedRegion, newRaw };
  }

  const newRaw = remaining.join(',');
  try {
    await kv.put(FLY_REGIONS_KV_KEY, newRaw);
  } catch {
    // Best-effort
  }
  return { action: 'removed', removedRegion: failedRegion, newRegions: remaining, newRaw };
}
