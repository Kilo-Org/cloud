/* eslint-disable max-lines -- one case per pill state: permission controls, the hidden pill and the reading share these render helpers. */
import { describe, expect, it, vi } from 'vitest';

import {
  classNameOf,
  expectHiddenPill,
  findAll,
  info,
  PILL_LAYOUT_TOKENS,
  pillOf,
  propsOf,
  render,
} from './session-context-metrics-test-helpers';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./context-usage-ring', () => ({ ContextUsageRing: 'ContextUsageRing' }));

/** The texts the pill paints: everything except the invisible slot sizers. */
function visibleTextsOf(pill: React.ReactElement): React.ReactElement[] {
  return findAll(pill, el => el.type === 'Text' && !classNameOf(el).includes('opacity-0'));
}

/** The invisible copies that hold each slot's width. */
function sizersOf(pill: React.ReactElement): React.ReactElement[] {
  return findAll(pill, el => el.type === 'Text' && classNameOf(el).includes('opacity-0'));
}

describe('SessionContextMetrics', () => {
  it.each([
    { hasMessages: true, cost: null },
    { hasMessages: true, cost: 150_000 },
    { hasMessages: false, cost: null },
  ])('opens permission controls without usage: $hasMessages / $cost', ({ hasMessages, cost }) => {
    const onPress = vi.fn<() => void>();
    const root = render({
      info: undefined,
      totalCostMicrodollars: cost,
      hasMessages,
      autoApproveAvailable: true,
      onPress,
    });
    const pill = pillOf(root);
    expect(pill.type).toBe('Pressable');
    const props = propsOf(pill);
    expect(props.accessibilityRole).toBe('button');
    expect(props.accessibilityLabel).toContain('Tap to view context details.');
    expect(props.className ?? '').not.toContain('opacity-0');
    for (const token of PILL_LAYOUT_TOKENS) {
      expect(props.className).toContain(token);
    }
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  // The header control is the only way to the session's permission settings,
  // so it must register a tap while the page is still loading instead of
  // rendering a dead, invisible control.
  it('keeps the context control tappable while the session page loads', () => {
    const onPress = vi.fn<() => void>();
    const root = render({
      info: undefined,
      totalCostMicrodollars: null,
      hasMessages: false,
      autoApproveAvailable: true,
      loading: true,
      onPress,
    });
    const pill = pillOf(root);
    expect(pill.type).toBe('Pressable');
    const props = propsOf(pill);
    expect(props.accessibilityRole).toBe('button');
    expect(props.className ?? '').not.toContain('opacity-0');
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  // Usage is already known, so the control must be live instead of an invisible
  // zero-size hit area.
  it('keeps the context control tappable for an empty session that reports usage', () => {
    const onPress = vi.fn<() => void>();
    const root = render({
      info: info(),
      totalCostMicrodollars: 150_000,
      hasMessages: false,
      onPress,
    });
    const pill = pillOf(root);
    expect(pill.type).toBe('Pressable');
    const props = propsOf(pill);
    expect(props.accessibilityRole).toBe('button');
    expect(props.className ?? '').not.toContain('opacity-0');
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  // Usage and permission controls are both still unknown while a session
  // opens (or after a failed open), but the parent can still open the sheet,
  // so the control must register a tap instead of a dead control.
  it('keeps the context control tappable with no usage and no permission controls', () => {
    const onPress = vi.fn<() => void>();
    const root = render({
      info: undefined,
      totalCostMicrodollars: null,
      hasMessages: false,
      autoApproveAvailable: false,
      onPress,
    });
    const pill = pillOf(root);
    expect(pill.type).toBe('Pressable');
    const props = propsOf(pill);
    expect(props.accessibilityRole).toBe('button');
    expect(props.accessibilityLabel).toContain('Tap to view context details.');
    expect(props.className ?? '').not.toContain('opacity-0');
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('does not expose permission controls while the session is loading and no sheet can open', () => {
    expectHiddenPill(
      render({
        info: undefined,
        totalCostMicrodollars: null,
        hasMessages: false,
        loading: true,
      })
    );
  });

  it('empty session is invisible and a11y-hidden', () => {
    expectHiddenPill(
      render({
        info: undefined,
        totalCostMicrodollars: null,
        hasMessages: false,
      })
    );
  });

  it('empty session with a cost stays fully hidden', () => {
    expectHiddenPill(
      render({
        info: undefined,
        totalCostMicrodollars: 150_000,
        hasMessages: false,
      })
    );
  });

  it('loading keeps the pill hidden', () => {
    expectHiddenPill(
      render({
        loading: true,
        hasMessages: true,
        info: undefined,
        totalCostMicrodollars: null,
      })
    );
  });

  it('loading wins over missing messages', () => {
    expectHiddenPill(
      render({
        loading: true,
        hasMessages: false,
        info: undefined,
        totalCostMicrodollars: null,
      })
    );
  });

  it('first message with cost but no context info shows a visible, non-pressable pill', () => {
    const root = render({
      hasMessages: true,
      info: undefined,
      totalCostMicrodollars: 150_000,
    });
    const pill = pillOf(root);
    expect(pill.type).toBe('View');
    const props = propsOf(pill);
    expect(props.className ?? '').not.toContain('opacity-0');
    expect(props.accessibilityElementsHidden).toBeUndefined();
    const texts = findAll(pill, el => el.type === 'Text');
    expect(
      texts.some(el => {
        const children = propsOf(el).children;
        return typeof children === 'string' && children.includes('$0.15');
      })
    ).toBe(true);
    expect(pill.type).not.toBe('Pressable');
  });

  it('context info with onPress renders the pressable pill', () => {
    const onPress = vi.fn(() => undefined);
    const root = render({
      hasMessages: true,
      info: info(),
      totalCostMicrodollars: 150_000,
      onPress,
    });
    const pill = pillOf(root);
    expect(pill.type).toBe('Pressable');
    const props = propsOf(pill);
    expect(props.accessibilityRole).toBe('button');
    expect(props.accessibilityLabel).toContain('Tap to view context details.');
    expect(props.className ?? '').not.toContain('opacity-0');
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
    const ring = findAll(pill, el => el.type === 'ContextUsageRing')[0];
    expect(ring).toBeDefined();
    if (ring == null) {
      throw new Error('expected ContextUsageRing');
    }
    const ringProps = ring.props as { arcFraction?: number; tone?: string };
    expect(ringProps.arcFraction).toBe(0.16);
    expect(ringProps.tone).toBe('primary');
  });

  it('context info without onPress stays a plain visible view', () => {
    const root = render({
      hasMessages: true,
      info: info(),
      totalCostMicrodollars: 150_000,
    });
    const pill = pillOf(root);
    expect(pill.type).toBe('View');
    const props = propsOf(pill);
    expect(props.className ?? '').not.toContain('opacity-0');
    expect(props.accessibilityLabel ?? '').not.toContain('Tap to view');
  });

  // The header caps the trailing cluster, and RN's flexShrink is 0 by default,
  // so the pill and its reading must all opt in or they paint off-screen. The
  it('keeps the pill compressible and each reading on one line', () => {
    const root = render({
      hasMessages: true,
      info: info(),
      totalCostMicrodollars: 150_000,
      onPress: vi.fn<() => void>(),
    });
    expect(classNameOf(root)).toContain('min-w-0');
    expect(classNameOf(root)).toContain('shrink');
    const pill = pillOf(root);
    // Every text the pill paints, its sizers included, is capped to one line:
    // the slot gives up width before the pill paints past the header's edge.
    expect(findAll(pill, el => el.type === 'Text')).toHaveLength(4);
    for (const text of findAll(pill, el => el.type === 'Text')) {
      expect(propsOf(text).numberOfLines).toBe(1);
    }
  });

  // A transcript that reports no usage and no cost paints a bare ring inside a
  // rect that is already the width of the reading it will show: the slots hold
  // their width invisibly instead of showing a dash or collapsing.
  it('paints no value and holds both slot widths when there is nothing to show', () => {
    const root = render({ hasMessages: true, info: undefined, totalCostMicrodollars: null });
    const pill = pillOf(root);
    expect(propsOf(pill).className ?? '').not.toContain('opacity-0');
    expect(propsOf(pill).accessibilityElementsHidden).toBeUndefined();
    expect(findAll(pill, el => el.type === 'ContextUsageRing')).toHaveLength(1);
    // Two sizers hold the two slots; neither paints and neither is read out.
    expect(sizersOf(pill)).toHaveLength(2);
    expect(visibleTextsOf(pill)).toHaveLength(0);
    for (const sizer of sizersOf(pill)) {
      expect(propsOf(sizer).accessibilityElementsHidden).toBe(true);
      expect(propsOf(sizer).importantForAccessibility).toBe('no');
    }
  });

  // A session that reported tokens but no context window has no percentage.
  // The pill paints the cost alone: a marker in the percentage slot sat right
  // before the price and read as a negative amount. The percentage slot keeps
  // its width while painting nothing.
  it('paints no marker before the cost when the context window is unknown', () => {
    const root = render({
      hasMessages: true,
      info: info({ contextWindow: undefined, percentage: undefined }),
      totalCostMicrodollars: 20_000,
    });
    const pill = pillOf(root);
    const texts = visibleTextsOf(pill);
    expect(texts).toHaveLength(1);
    const cost = texts[0];
    if (cost == null) {
      throw new Error('expected the cost text');
    }
    expect(String(propsOf(cost).children)).toContain('$0.02');
    expect(sizersOf(pill)).toHaveLength(2);
    expect(findAll(pill, el => el.type === 'ContextUsageRing')).toHaveLength(1);
    expect(
      findAll(pill, el => el.type === 'ContextUsageRing' && propsOf(el).arcFraction === undefined)
    ).toHaveLength(1);
  });

  // The reading is two values with one small gap, painted over the slots that
  // already held their widths before the values existed.
  it('paints the percentage and the cost over their reserved slots', () => {
    const root = render({
      hasMessages: true,
      info: info(),
      totalCostMicrodollars: 150_000,
      onPress: vi.fn<() => void>(),
    });
    const pill = pillOf(root);
    const [row] = findAll(pill, el => classNameOf(el).includes('gap-1'));
    expect(row).toBeDefined();
    expect(classNameOf(row ?? root)).toContain('flex-row');
    const texts = visibleTextsOf(pill);
    expect(texts.map(el => propsOf(el).children)).toEqual([
      propsOf(texts[0] ?? root).children,
      propsOf(texts[1] ?? root).children,
    ]);
    expect(texts[0]).toBeDefined();
    expect(texts[1]).toBeDefined();
    expect(propsOf(texts[0] ?? root).children).toBe('16%');
    expect(String(propsOf(texts[1] ?? root).children)).toContain('$0.15');
    // Each painted value sits over the slot that reserved its width.
    expect(classNameOf(texts[0] ?? root)).toContain('absolute');
    expect(classNameOf(texts[1] ?? root)).toContain('absolute');
  });

  // One silhouette from the first paint: the slots reserve the width of the
  // reading that will fill them, so a settled empty pill is already the size it
  // keeps once usage arrives. While the open resolves, one bar covers the row.
  it('holds the reading-row width while loading and after it settles', () => {
    const onPress = vi.fn<() => void>();
    const bare = (loading = false) =>
      render({
        info: undefined,
        totalCostMicrodollars: null,
        hasMessages: false,
        loading,
        onPress,
      });

    for (const pill of [pillOf(bare(false)), pillOf(bare(true))]) {
      expect(findAll(pill, el => el.type === 'ContextUsageRing')).toHaveLength(1);
      expect(visibleTextsOf(pill)).toHaveLength(0);
      expect(sizersOf(pill)).toHaveLength(2);
    }
    // The bar belongs to the resolving state only; the settled pill carries none.
    expect(findAll(pillOf(bare(true)), el => el.type === 'Skeleton')).toHaveLength(1);
    expect(findAll(pillOf(bare(false)), el => el.type === 'Skeleton')).toHaveLength(0);
    expect(propsOf(pillOf(bare(false))).accessibilityLabel).toContain('usage unavailable');
    expect(propsOf(pillOf(bare(true))).accessibilityLabel ?? '').not.toContain('usage unavailable');
  });
});
