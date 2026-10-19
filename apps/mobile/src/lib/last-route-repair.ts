/**
 * Whether the cold-start relaunch repair should navigate to the recorded
 * route: the record must belong to this account, name a recordable route
 * (never a gate), and differ from the route the process actually restored
 * (the base Intent's destination). Same path means the OS restore already
 * reopened the right screen and there is nothing to repair. Group segments
 * (`(app)`, `(tabs)`) are stripped from both sides: `usePathname()` reports
 * them, the recorded href keeps them, and they are routing groups, not
 * destinations.
 */
export function shouldRepairRestoredRoute(input: {
  readonly recordedHref: string | null;
  readonly restoredPathname: string;
}): boolean {
  if (input.recordedHref === null) {
    return false;
  }
  return normalizeRoutePath(input.recordedHref) !== normalizeRoutePath(input.restoredPathname);
}

function normalizeRoutePath(path: string): string {
  const withoutQuery = path.includes('?') ? path.slice(0, path.indexOf('?')) : path;
  return withoutQuery
    .split('/')
    .filter(part => part.length > 0 && !(part.startsWith('(') && part.endsWith(')')))
    .join('/');
}
