// Persisted navigation survives app upgrades; these retired route groups must still resolve.
const MOVED_ROUTE_PREFIXES: readonly (readonly [string, string])[] = [
  ['/(app)/(tabs)/(3_profile)/code-reviewer', '/(app)/code-reviewer'],
  ['/(app)/(tabs)/(3_profile)/security-agent', '/(app)/security-agent'],
];

export function currentRouteHref(href: string): string {
  for (const [from, to] of MOVED_ROUTE_PREFIXES) {
    if (href === from || href.startsWith(`${from}/`) || href.startsWith(`${from}?`)) {
      return `${to}${href.slice(from.length)}`;
    }
  }
  return href;
}
