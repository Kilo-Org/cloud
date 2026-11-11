import type { ProbeDump, ProbeNode } from './tree';

/** The file suffix a route component's name carries, e.g. `./(app)/history.tsx`. */
const ROUTE_FILE = /\.[jt]sx?$/;

/**
 * A route's path below the app directory, as both the focused screen key and a
 * node's route file name it: file suffix dropped, and the `index` and `_layout`
 * steps with it, so a path names the screen rather than the file. The key
 * `(app)/(tabs)/history` and the file `./(app)/(tabs)/history.tsx` are one screen.
 */
function routePath(route: string): string {
  return route
    .replace(/^\.\//, '')
    .replace(ROUTE_FILE, '')
    .replace(/(^|\/)(index|_layout)$/, '');
}

/**
 * Drop the screens a dump carries behind the focused one.
 *
 * A tab navigator keeps every tab's screen mounted, so a dump of a pushed route
 * also carries the tab it was pushed from — for the History screen that is the
 * Home tab, which keeps polling and re-laying itself out. Those frames are
 * painted behind the measured screen: they are not what a cell sees, and their
 * churn makes an otherwise static screen look like it never settles, which
 * turned every capture on a pushed route into `unsettled` or a bracketing
 * mismatch on the merge base as well as on a branch.
 *
 * Every node names the route file of its screen, the whole path below the app
 * directory, so a screen is told from the tab behind it by its own path. The
 * navigator's route name cannot do that: a navigator names a route relative to
 * itself, so a screen on a pushed route and a background tab can carry the same
 * name. Screen subtrees above the focused one stay, because they are chrome the
 * cell still measures — the root view, the tab bar.
 *
 * Fails open, so no screen is ever measured differently merely because this rule
 * could not read it: when no node names the focused screen, or when every screen
 * is on the focused path, the dump is returned untouched.
 */
export function scopeToFocusedRoute(dump: ProbeDump): ProbeDump {
  if (dump.nodes.length === 0 || dump.env.screen === undefined) {
    return dump;
  }
  const focused = routePath(dump.env.screen);
  const backgroundScreens = new Set<number>();
  let focusedScreens = 0;
  for (const [index, node] of dump.nodes.entries()) {
    if (node.screen === undefined) {
      continue;
    }
    const screen = routePath(node.screen);
    if (screen === focused) {
      focusedScreens += 1;
    } else if (screen !== '' && !focused.startsWith(`${screen}/`)) {
      backgroundScreens.add(index);
    }
  }
  if (focusedScreens === 0 || backgroundScreens.size === 0) {
    return dump;
  }
  // A dump lists a parent before its children, so one forward pass carries each
  // node's fate down its subtree and rewrites the parent index against the kept
  // order.
  const dropped: boolean[] = [];
  const positionOf: number[] = [];
  const kept: ProbeNode[] = [];
  for (const [index, node] of dump.nodes.entries()) {
    const parentDropped = node.parent >= 0 && dropped[node.parent] === true;
    const isDropped = parentDropped || backgroundScreens.has(index);
    dropped.push(isDropped);
    if (isDropped) {
      positionOf.push(-1);
    } else {
      let parent = node.parent;
      while (parent >= 0 && positionOf[parent] === -1) {
        parent = dump.nodes[parent]?.parent ?? -1;
      }
      positionOf.push(kept.length);
      kept.push({ ...node, parent: parent < 0 ? -1 : (positionOf[parent] ?? -1) });
    }
  }
  return { ...dump, nodes: kept };
}
