/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- the stringified widget layout is only observable as source text */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The `'widget'` layout is stringified by Babel and re-evaluated inside the
// widget process, so no widget transform runs under vitest and the layout never
// renders here. Its accessibility tree is pinned where it is observable: the
// source that reaches the widget process. VoiceOver reaches the Approve control
// only while no ancestor combined element swallows it, so these assertions read
// where each `combine` ends.
const source = readFileSync(join(__dirname, 'active-agents-live-activity.tsx'), 'utf8');

const COMBINE = "accessibilityElement('combine')";
const APPROVE_TARGET = 'target="approve"';

/** One section of the returned layout object, from its key to the next key at the same indentation. */
const section = (key: string): string => {
  const pattern = new RegExp(`\\n {4}${key}: ([\\s\\S]*?)(?=\\n {4}[A-Za-z]+: |\\n {2}\\};\\n)`);
  const match = source.match(pattern);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
};

/** The `markAndRows` block, which the phone banner and the expanded island share. */
const markAndRowsSource = (): string => {
  const start = source.indexOf('const markAndRows');
  const end = source.indexOf('\n  return {', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

/**
 * The element one `combine` scopes: the `<HStack>` that opens at or before it,
 * through its matching close. The layout's self-closing tags are `Image`,
 * `Button`, and `Spacer`, so counting `<HStack` against `</HStack>` finds the
 * close without parsing JSX.
 */
const combinedElement = (text: string, at: number): { after: number; body: string } => {
  const open = text.lastIndexOf('<HStack', at);
  expect(open).toBeGreaterThanOrEqual(0);
  const tags = /<\/?HStack/g;
  tags.lastIndex = open;
  let depth = 0;
  let match = tags.exec(text);
  while (match !== null) {
    depth += match[0] === '</HStack' ? -1 : 1;
    if (depth === 0) {
      return { after: match.index, body: text.slice(open, match.index) };
    }
    match = tags.exec(text);
  }
  throw new Error('unbalanced HStack in the layout source');
};

describe('glanceable live activity accessibility scoping', () => {
  it('combines the count block alone and leaves the Approve control outside it', () => {
    // The Lock Screen banner and the expanded island both draw `markAndRows`.
    // A `combine` on that whole row merged the Approve Button into one element
    // whose spoken label named the counts and "Open agents", so VoiceOver had
    // no focusable Approve action. The block must combine only the counts, and
    // the control must follow the combined element as a sibling.
    const block = markAndRowsSource();
    const combined = combinedElement(block, block.indexOf(COMBINE));

    expect(combined.body).toContain('countRows');
    expect(combined.body).toContain('accessibilityLabel(accessibility)');
    expect(combined.body).not.toContain('<Button');
    expect(combined.body).not.toContain(APPROVE_TARGET);
    expect(block.slice(combined.after)).toContain(APPROVE_TARGET);
  });

  it('leaves the phone banner wrapper outside any combined element', () => {
    const banner = section('banner');
    expect(banner).toContain('markAndRows');
    expect(banner).not.toContain(COMBINE);
    expect(banner).not.toContain('accessibilityLabel(accessibility)');
  });

  it('leaves the expanded island wrapper outside any combined element', () => {
    // The island draws the same block, so a label on the island wrapper would
    // re-group the Approve control the block keeps separate.
    const expanded = section('expandedBottom');
    expect(expanded).toContain('markAndRows');
    expect(expanded).not.toContain(COMBINE);
    expect(expanded).not.toContain('accessibilityLabel(accessibility)');
  });

  it('keeps the watch bannerSmall count row combined and its control a sibling', () => {
    // The watch pattern the phone block now mirrors: the combined label rides
    // the count row alone, so the wrist can still focus and activate Approve.
    const small = section('bannerSmall');
    const combined = combinedElement(small, small.indexOf(COMBINE));

    expect(combined.body).toContain('countRow');
    expect(combined.body).not.toContain('<Button');
    expect(small.slice(combined.after)).toContain(APPROVE_TARGET);
  });
});
