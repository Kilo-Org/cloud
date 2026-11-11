import type { ProbeDump, ProbeNode } from './tree';

/** The navigator route a screen node belongs to, from its owner chain. */
const ROUTE_OWNER = /^Route\((.+)\)$/;

/**
 * Whether a screen's route is the focused one.
 *
 * A navigator names a pushed route with the screen's whole path
 * (`Route(agent-chat/[session-id])`) while the probe reports the focused screen as
 * the grouped key (`(app)/agent-chat/[session-id]`), whose last segment is the leaf
 * (`[session-id]`). Matching the leaf alone left every pushed route unmatched, so
 * the tab behind it stayed in the dump and its churn made a static screen
 * unmeasurable. A route therefore matches on the leaf segment or on that path's tail.
 */
function isFocusedRoute(route: string, focusedRoute: string): boolean {
  return route === focusedRoute || route.endsWith(`/${focusedRoute}`);
}

function routeOwner(node: ProbeNode): string | null {
  for (const owner of node.owners ?? []) {
    const match = ROUTE_OWNER.exec(owner);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
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
 * A screen node names its navigator route in its owner chain (`Route(history)`),
 * the only per-node route identity a dump offers. Each subtree rooted at such a
 * screen is kept only when the focused route names it. Nodes outside any route
 * screen — the root view, the tab bar — stay, because they are chrome the cell
 * still measures.
 *
 * Fails open, so no screen is ever measured differently merely because this
 * rule could not read it: when the focused route names no screen in the dump (a
 * navigator that registers a tab as `index`), or when every screen is the
 * focused one, the dump is returned untouched.
 */
export function scopeToFocusedRoute(dump: ProbeDump): ProbeDump {
  if (dump.nodes.length === 0 || dump.env.screen === undefined) {
    return dump;
  }
  const segments = dump.env.screen.split('/');
  const focusedRoute = segments.findLast(segment => segment !== '');
  if (focusedRoute === undefined) {
    return dump;
  }
  const backgroundScreens = new Set<number>();
  let focusedScreens = 0;
  for (const [index, node] of dump.nodes.entries()) {
    const route = routeOwner(node);
    if (route !== null && isFocusedRoute(route, focusedRoute)) {
      focusedScreens += 1;
    } else if (route !== null) {
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
