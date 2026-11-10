import { type ReactTestInstance } from '@/test/renderer';

/**
 * The ancestors of `node` that carry a Reanimated `entering` prop.
 *
 * An entering animation carries `initialValues: { opacity: 0 }`, so a subtree
 * mounted under one starts invisible and only paints once its entrance runs. A
 * mount that lands while the app is not foreground, or an entrance a layout
 * animation overwrites, leaves the content mounted at opacity 0: the screen
 * header outside the animated view paints, the body area stays a uniform
 * background, the accessibility tree holds no body node, and nothing offers a
 * retry — Android `profile-error` (2026-09-22) and the security agent's scope
 * entry both shipped that way. Content that arrives with an async read must
 * therefore have no `entering` ancestor, which is what `toEqual([])` on this
 * helper asserts.
 */
export function enteringAncestors(node: ReactTestInstance | undefined): string[] {
  const ancestors: string[] = [];
  for (let parent = node?.parent ?? null; parent; parent = parent.parent) {
    if ('entering' in parent.props) {
      ancestors.push(String(parent.type));
    }
  }
  return ancestors;
}
