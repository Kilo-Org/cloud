import { type ProbeNode } from '@/lib/design-gate/collect';

/** The navigator route a screen node belongs to, from its owner chain. */
const ROUTE_OWNER = /^Route\((.+)\)$/;

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
 * Keep only the part of a probe tree that belongs to the focused route.
 *
 * A tab navigator keeps every tab's screen mounted, so a dump of a pushed route
 * also carries the tab it was pushed from: the Home tab keeps polling and
 * re-laying itself out under the History screen. Those frames are painted
 * behind the focused screen, so they are not what a cell measures, and their
 * churn makes an otherwise static screen look like it never settles.
 *
 * A screen node names its navigator route in its owner chain (`Route(history)`),
 * which is the only per-node route identity the probe has. Every subtree rooted
 * at such a screen is kept only when that route is the focused one. Nodes
 * outside any route screen (the root view, the tab bar) stay, because they are
 * chrome the cell still measures.
 *
 * Fails open: when the focused route names no screen in the tree — a route the
 * navigator registers under an internal name, such as a tab's `index` — the
 * tree is returned untouched, so every screen that could not be scoped keeps
 * exactly the measurement it had before.
 */
export function scopeToFocusedRoute(
  nodes: readonly ProbeNode[],
  focusedRoute: string | null
): readonly ProbeNode[] {
  if (focusedRoute === null || nodes.length === 0) {
    return nodes;
  }
  const backgroundScreens = new Set<number>();
  let focusedScreens = 0;
  for (const [index, node] of nodes.entries()) {
    const route = routeOwner(node);
    if (route === focusedRoute) {
      focusedScreens += 1;
    } else if (route !== null) {
      backgroundScreens.add(index);
    }
  }
  if (focusedScreens === 0 || backgroundScreens.size === 0) {
    return nodes;
  }
  // A dump lists a parent before its children, so one forward pass carries each
  // node's fate down its subtree and rewrites the parent index against the kept
  // order.
  const dropped: boolean[] = [];
  const positionOf: number[] = [];
  const kept: ProbeNode[] = [];
  for (const [index, node] of nodes.entries()) {
    const parentDropped = node.parent >= 0 && dropped[node.parent] === true;
    const isDropped = parentDropped || backgroundScreens.has(index);
    dropped.push(isDropped);
    if (isDropped) {
      positionOf.push(-1);
    } else {
      let parent = node.parent;
      while (parent >= 0 && positionOf[parent] === -1) {
        parent = nodes[parent]?.parent ?? -1;
      }
      positionOf.push(kept.length);
      kept.push({ ...node, parent: parent < 0 ? -1 : (positionOf[parent] ?? -1) });
    }
  }
  return kept;
}
