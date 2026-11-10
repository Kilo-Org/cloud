/**
 * The `(app)` stack's picker sheets, by the pathname expo-router reports while
 * one of them is on top.
 *
 * A picker is a native `formSheet` route presented over the screen that opened
 * it. On Android the presentation is not part of the native fragment stack yet
 * when the sheet is still opening, so a hardware Back that lands in that window
 * is delivered to the screen underneath. These pathnames let that screen tell
 * "a picker of mine is on top" apart from "I am the top" and keep the Back with
 * the picker it belongs to.
 *
 * Keep this list aligned with the `Stack.Screen` entries that register
 * `presentation: 'formSheet'` in `apps/mobile/src/app/(app)/_layout.tsx`; a
 * picker route missing here falls back to the old behaviour.
 */
export const PICKER_ROUTE_PATHS = [
  '/agent-chat/repo-picker',
  '/agent-chat/branch-picker',
  '/agent-chat/mode-picker',
  '/agent-chat/model-picker',
  '/agent-chat/instance-picker',
  '/agent-chat/folder-picker',
  '/agent-chat/profile-picker',
] as const satisfies readonly string[];

/** Route names as they appear in the navigation state (no leading slash). */
export const PICKER_ROUTE_NAMES: readonly string[] = PICKER_ROUTE_PATHS.map(path =>
  path.replace(/^\//, '')
);

export function isPickerRoutePath(pathname: string | null | undefined): boolean {
  if (pathname === null || pathname === undefined) {
    return false;
  }
  return (PICKER_ROUTE_PATHS as readonly string[]).includes(pathname);
}

type RouteStackState = {
  index?: number;
  routes?: { name?: string }[];
};

/**
 * Whether a picker is the top route of a stack's navigation state.
 *
 * Read from the navigation state at the moment a removal is refused, not from a
 * render: during the picker's opening window the screen under it has not
 * re-rendered yet, but the pushed picker is already in the state.
 */
export function pickerRouteOnTop(state: RouteStackState | undefined): boolean {
  const index = state?.index ?? (state?.routes?.length ?? 0) - 1;
  const top = state?.routes?.[index];
  return top?.name !== undefined && PICKER_ROUTE_NAMES.includes(top.name);
}
