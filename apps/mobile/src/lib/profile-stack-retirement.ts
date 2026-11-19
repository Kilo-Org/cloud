/**
 * The second half of the profile stack repair: retiring the unparented copy of a
 * profile screen once its rebuilt copy is on top.
 *
 * The repair pushes the missing parents and re-pushes the screen above them, and
 * only then may the original copy go: removing a screen and inserting another in
 * one commit is the shape the Android native stack crashes on
 * (`navigation/stack-safe-replace.ts`), which is why the repair is two pushes and
 * a later removal instead of one `reset`.
 *
 * The pending copy lives here, outside the screen that asked for the repair,
 * because that screen is the one being retired: a native Stack unmounts a covered
 * screen, so the copy that pushed the parents no longer runs code when its
 * rebuilt copy lands. Its pending removal therefore has to outlive it, and be
 * judged by whichever profile screen is alive to see the navigator's next state.
 *
 * No React and no React Native imports: the decision is unit-tested directly in
 * `profile-stack-retirement.test.ts`.
 */

/** A route as the retirement reads it: the identity the navigator keys it by. */
type RetirementRoute = Readonly<{ key: string; name: string }>;

/** One original copy still waiting for the rebuilt copy above it. */
type PendingRetirement = Readonly<{
  /** The route name the rebuilt copy is focused under, so a stray screen never retires it. */
  selfName: string;
  /** When this original stops being retirable, so a lost state event cannot act later. */
  expiresAt: number;
}>;

/**
 * How long an original copy stays retirable. The rebuilt pushes carry no
 * transition, so this only covers a navigator that never reports the state that
 * put the rebuilt copy on top; past this bound the repair is abandoned instead of
 * removing a screen the reader is using minutes later.
 */
export const PROFILE_RETIREMENT_TTL_MS = 5_000;

/**
 * The copies still waiting, keyed by `<stack>/<route key>`.
 *
 * The scope matters: the app renders two Stacks that each hold profile screens
 * (the Profile tab's and the app-level Manage Profiles one), and both subscribe
 * to their own navigator's state. Without the scope, a state event in one Stack
 * would find a pending copy of the other absent from its routes and forget it, so
 * the original would stay in the stack it belongs to.
 */
const pending = new Map<string, PendingRetirement>();

function pendingKey(stack: string, key: string): string {
  return `${stack}/${key}`;
}

function dropExpired(now: number): void {
  for (const [key, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(key);
    }
  }
}

/**
 * Record that `key` is the original copy of a screen named `selfName`, to be
 * removed once that screen's rebuilt copy is the focused route of `stack`.
 */
export function notePendingProfileRetirement({
  key,
  stack,
  selfName,
  now,
}: Readonly<{ key: string; stack: string; selfName: string; now: number }>): void {
  dropExpired(now);
  pending.set(pendingKey(stack, key), { selfName, expiresAt: now + PROFILE_RETIREMENT_TTL_MS });
}

/** Drop every pending retirement: tests assert from a known state. */
export function resetPendingProfileRetirementsForTests(): void {
  pending.clear();
}

/**
 * The stack `routes` with every retirable original copy of `stack` removed, or
 * null when nothing is retirable yet.
 *
 * A copy is retirable only when it is still in the stack, it is not the focused
 * route, and the focused route is a screen of the same name — i.e. this screen's
 * rebuilt copy is the one on top, not some other screen the reader opened. The
 * focused route is never removed, so the returned index is the focused route's own
 * position after the removals.
 */
export function takeRetirableProfileRoutes<T extends RetirementRoute>({
  routes,
  index,
  stack,
  now,
}: Readonly<{
  routes: readonly T[];
  index: number;
  stack: string;
  now: number;
}>): { routes: T[]; index: number } | null {
  dropExpired(now);
  if (pending.size === 0) {
    return null;
  }
  const focused = routes[index];
  if (focused === undefined) {
    return null;
  }
  const retirable = new Set<string>();
  const prefix = `${stack}/`;
  const owned = [...pending].filter(([entryKey]) => entryKey.startsWith(prefix));
  for (const [entryKey, entry] of owned) {
    const key = entryKey.slice(prefix.length);
    if (!routes.some(route => route.key === key)) {
      // The original left this stack some other way: nothing to remove.
      pending.delete(entryKey);
    } else if (key !== focused.key && focused.name === entry.selfName) {
      retirable.add(key);
    }
  }
  if (retirable.size === 0) {
    return null;
  }
  const nextRoutes = routes.filter(route => !retirable.has(route.key));
  const nextIndex = nextRoutes.findIndex(route => route.key === focused.key);
  if (nextIndex === -1) {
    return null;
  }
  for (const key of retirable) {
    pending.delete(pendingKey(stack, key));
  }
  return { routes: nextRoutes, index: nextIndex };
}
