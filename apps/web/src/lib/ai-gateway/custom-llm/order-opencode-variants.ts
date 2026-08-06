import type { OpenCodeSettings } from '@kilocode/db/schema-types';

const VARIANT_ORDERS = [
  ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  ['instant', 'thinking'],
  ['instant', 'low', 'medium', 'high'],
] as const;

function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function orderOpenCodeVariants(
  variants: NonNullable<OpenCodeSettings['variants']>
): NonNullable<OpenCodeSettings['variants']> {
  const entries = Object.entries(variants);
  const names = entries.map(([name]) => name);
  const ranks = VARIANT_ORDERS.find(rank =>
    names.every(name => rank.some(rankedName => rankedName === name))
  );
  const rank = (name: string) => ranks?.findIndex(rankedName => rankedName === name) ?? -1;

  return Object.fromEntries(
    entries.sort(([a], [b]) => (ranks ? rank(a) - rank(b) : compareNames(a, b)))
  );
}

export function orderOpenCodeSettings(
  settings: OpenCodeSettings | undefined
): OpenCodeSettings | undefined {
  if (!settings?.variants) return settings;

  return {
    ...settings,
    variants: orderOpenCodeVariants(settings.variants),
  };
}
