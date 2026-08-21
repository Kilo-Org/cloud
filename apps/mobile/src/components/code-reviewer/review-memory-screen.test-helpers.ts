// Test helpers shared by the review-memory mounted tests: walk a rendered
// react-test-renderer tree and collect text or accessibility labels. Kept in a
// separate module so the test file stays under the repo's max-lines limit.

export function collectText(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(n => collectText(n));
  }
  if (typeof node === 'object' && 'children' in node) {
    return collectText((node as { children?: unknown }).children);
  }
  return [];
}

export function collectAccessibilityLabels(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(n => collectAccessibilityLabels(n));
  }
  if (typeof node === 'object') {
    const obj = node as { props?: { accessibilityLabel?: string }; children?: unknown };
    const own = obj.props?.accessibilityLabel ? [obj.props.accessibilityLabel] : [];
    return [...own, ...collectAccessibilityLabels(obj.children)];
  }
  return [];
}
