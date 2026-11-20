import { finding, type Finding } from '../findings';
import type { LayoutNode, LayoutTree } from '../tree';

/**
 * Rules for a screen caught in its own loading state.
 *
 * The gate holds a screen's data pending with the dev force-state link
 * (`kiloapp:///dev/force-state/loading?next=…`), measures the frame it paints
 * instead of waiting for content, then releases the hold and samples what the
 * content lands on. `checkShift` reads that one timeline, so the jump between
 * the placeholder and the content is measured where it happens rather than
 * inferred by comparing two captures.
 *
 * The rules here judge what only the loading frame can answer: whether the
 * screen says it is waiting at all, and whether a reader hears it.
 */

function isProgress(node: LayoutNode): boolean {
  return node.probe.role === 'progressbar' || /progress|activityindicator/i.test(node.probe.tag);
}

function isSkeleton(node: LayoutNode): boolean {
  if (isProgress(node)) return false;
  const { testID, owners } = node.probe;
  return (
    (testID !== undefined && /(?:^|-)skeleton$/u.test(testID)) ||
    (owners ?? []).some(owner => /skeleton/i.test(owner))
  );
}

export function loadingPlaceholders(tree: LayoutTree): readonly LayoutNode[] {
  return tree.nodes.filter(node => isSkeleton(node) || isProgress(node));
}

/**
 * The screen paints nothing that says it is loading.
 *
 * A skeleton owns the loaded geometry, so it both says "waiting" and reserves
 * the space the content will take. A screen with neither a skeleton nor a
 * progress indicator is blank until its content lands, which reads as a broken
 * screen rather than a slow one.
 */
export function checkLoadingAffordance(tree: LayoutTree): Finding[] {
  if (loadingPlaceholders(tree).length > 0) return [];
  return [
    finding({
      rule: 'loading-placeholder',
      severity: 'warning',
      element: tree.roots[0]?.ref ?? { index: 0, path: '', tag: 'root', rect: [0, 0, 0, 0] },
      measured: 0,
      expected: 'a skeleton that owns the loaded geometry, or a progress indicator',
      unit: 'dp',
      message:
        'The screen paints no loading placeholder while its data is pending: no skeleton and no ' +
        'progress indicator, so the screen is blank until the content lands.',
    }),
  ];
}

/**
 * A progress indicator a screen reader cannot name.
 *
 * A progress bar announces itself with whatever name the node carries; an
 * unnamed one tells a waiting person that something is happening but not what.
 */
export function checkLoadingLabels(tree: LayoutTree): Finding[] {
  return tree.nodes
    .filter(
      node => isProgress(node) && node.probe.label === undefined && node.probe.text === undefined
    )
    .map(node =>
      finding({
        rule: 'loading-unlabelled',
        severity: 'error',
        element: node.ref,
        measured: 0,
        expected: 'an accessibility label naming the wait it reports',
        unit: 'dp',
        message:
          'The progress indicator carries no accessible name, so a screen reader announces an ' +
          'unnamed progress bar.',
      })
    );
}
