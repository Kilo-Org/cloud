/* oxlint-disable anti-slop/no-runtime-typeof -- walks arbitrary ReactNode
 * trees and untyped component props at runtime; there is no shared
 * discriminant to narrow string/number leaves or generic prop values. */
import { isValidElement, type ReactNode } from 'react';

import { i18n } from '@/i18n';
import { formatList } from '@/lib/format';

/**
 * Spoken text for a rendered markdown node. Strings and numbers are returned
 * verbatim; arrays are joined with a single space; elements use their explicit
 * `accessibilityLabel` when one is set, otherwise recurse into `children`;
 * every other node (null, undefined, boolean) produces an empty string.
 */
export function extractNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((item: ReactNode) => extractNodeText(item)).join(' ');
  }
  if (isValidElement(node)) {
    const props = node.props as { accessibilityLabel?: unknown; children?: ReactNode };
    if (typeof props.accessibilityLabel === 'string' && props.accessibilityLabel.length > 0) {
      return props.accessibilityLabel;
    }
    return extractNodeText(props.children);
  }
  return '';
}

/**
 * Linear reading of one table row: every non-empty cell is paired with its
 * column header ("Header: cell") and the pairs are joined with a comma. Cells
 * without a header keep their bare value; empty cells are skipped.
 */
export function linearRowLabel(header: string[], cells: string[]): string {
  const parts: string[] = [];
  const columnCount = Math.max(header.length, cells.length);
  for (let index = 0; index < columnCount; index += 1) {
    const cellText = (cells[index] ?? '').trim();
    const headerText = (header[index] ?? '').trim();
    if (cellText) {
      parts.push(headerText ? `${headerText}: ${cellText}` : cellText);
    }
  }
  return formatList(parts, i18n.language);
}

/**
 * True when the tree contains an activatable node — any element carrying an
 * `onPress` prop. Markdown links and images render as `Pressable`, so this
 * finds every control a rendered cell can hold.
 */
export function containsPressable(node: ReactNode): boolean {
  if (Array.isArray(node)) {
    return node.some((item: ReactNode) => containsPressable(item));
  }
  if (!isValidElement(node)) {
    return false;
  }
  const props = node.props as { onPress?: unknown; children?: ReactNode };
  if (typeof props.onPress === 'function') {
    return true;
  }
  return containsPressable(props.children);
}
