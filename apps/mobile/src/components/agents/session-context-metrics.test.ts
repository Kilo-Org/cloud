import { describe, expect, it, vi } from 'vitest';

import {
  expectHiddenReservedBox,
  findAll,
  info,
  PILL_LAYOUT_TOKENS,
  render,
} from './session-context-metrics-test-helpers';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./context-usage-ring', () => ({ ContextUsageRing: 'ContextUsageRing' }));

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
    expect(root.type).toBe('Pressable');
    const props = root.props as {
      accessibilityRole: string;
      accessibilityLabel: string;
      onPress: () => void;
      className: string;
    };
    expect(props.accessibilityRole).toBe('button');
    expect(props.accessibilityLabel).toContain('Tap to view context details.');
    expect(props.className).not.toContain('opacity-0');
    for (const token of PILL_LAYOUT_TOKENS) {
      expect(props.className).toContain(token);
    }
    props.onPress();
    expect(onPress).toHaveBeenCalledOnce();
  });

  // The header control is the only way to the session's permission settings,
  // so it must register a tap while the page is still loading instead of
  // rendering a dead, invisible reserved box.
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
    expect(root.type).toBe('Pressable');
    const props = root.props as {
      accessibilityRole?: string;
      onPress?: () => void;
      className?: string;
    };
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
    expect(root.type).toBe('Pressable');
    const props = root.props as {
      accessibilityRole?: string;
      onPress?: () => void;
      className?: string;
    };
    expect(props.accessibilityRole).toBe('button');
    expect(props.className ?? '').not.toContain('opacity-0');
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  // Usage and permission controls are both still unknown while a session
  // opens (or after a failed open), but the parent can still open the sheet,
  // so the control must register a tap instead of a dead reserved box.
  it('keeps the context control tappable with no usage and no permission controls', () => {
    const onPress = vi.fn<() => void>();
    const root = render({
      info: undefined,
      totalCostMicrodollars: null,
      hasMessages: false,
      autoApproveAvailable: false,
      onPress,
    });
    expect(root.type).toBe('Pressable');
    const props = root.props as {
      accessibilityRole?: string;
      accessibilityLabel?: string;
      onPress?: () => void;
      className?: string;
    };
    expect(props.accessibilityRole).toBe('button');
    expect(props.accessibilityLabel).toContain('Tap to view context details.');
    expect(props.className ?? '').not.toContain('opacity-0');
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('does not expose permission controls while the session is loading and no sheet can open', () => {
    expectHiddenReservedBox(
      render({
        info: undefined,
        totalCostMicrodollars: null,
        hasMessages: false,
        loading: true,
      })
    );
  });

  it('empty session is invisible and a11y-hidden', () => {
    const root = render({
      info: undefined,
      totalCostMicrodollars: null,
      hasMessages: false,
    });
    expectHiddenReservedBox(root);
  });

  it('empty session with a cost stays fully hidden', () => {
    const root = render({
      info: undefined,
      totalCostMicrodollars: 150_000,
      hasMessages: false,
    });
    expectHiddenReservedBox(root);
  });

  it('loading keeps the reserved invisible box', () => {
    const root = render({
      loading: true,
      hasMessages: true,
      info: undefined,
      totalCostMicrodollars: null,
    });
    expectHiddenReservedBox(root);
  });

  it('loading wins over missing messages', () => {
    const root = render({
      loading: true,
      hasMessages: false,
      info: undefined,
      totalCostMicrodollars: null,
    });
    expectHiddenReservedBox(root);
  });

  it('first message with cost but no context info shows a visible, non-pressable pill', () => {
    const root = render({
      hasMessages: true,
      info: undefined,
      totalCostMicrodollars: 150_000,
    });
    expect(root.type).toBe('View');
    const className = (root.props as { className?: string }).className ?? '';
    expect(className).not.toContain('opacity-0');
    expect(
      (root.props as { accessibilityElementsHidden?: boolean }).accessibilityElementsHidden
    ).toBeUndefined();
    const texts = findAll(root, el => el.type === 'Text');
    expect(
      texts.some(el => {
        const children = (el.props as { children?: unknown }).children;
        return children === '$0.15';
      })
    ).toBe(true);
    expect(root.type).not.toBe('Pressable');
  });

  it('context info with onPress renders the pressable pill', () => {
    const onPress = vi.fn(() => undefined);
    const root = render({
      hasMessages: true,
      info: info(),
      totalCostMicrodollars: 150_000,
      onPress,
    });
    expect(root.type).toBe('Pressable');
    const props = root.props as {
      accessibilityRole?: string;
      accessibilityLabel?: string;
      className?: string;
      onPress?: () => void;
    };
    expect(props.accessibilityRole).toBe('button');
    expect(props.accessibilityLabel).toContain('Tap to view context details.');
    expect(props.className ?? '').not.toContain('opacity-0');
    props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
    const ring = findAll(root, el => el.type === 'ContextUsageRing')[0];
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
    expect(root.type).toBe('View');
    const className = (root.props as { className?: string }).className ?? '';
    expect(className).not.toContain('opacity-0');
    const label = (root.props as { accessibilityLabel?: string }).accessibilityLabel ?? '';
    expect(label).not.toContain('Tap to view');
  });

  // The header row hands the trailing cluster a capped 50% box, but RN's
  // default flexShrink is 0, so the pill must opt in to shrinking and let its
  // inner text row compress. Otherwise the pill keeps its natural width and
  // paints past the row's right edge — off-screen on a narrow phone.
  it('lets the pill and its text row compress inside a constrained header row', () => {
    const root = render({
      hasMessages: true,
      info: info(),
      totalCostMicrodollars: 150_000,
      onPress: vi.fn(() => undefined),
    });
    const textRow = findAll(
      root,
      el =>
        el.type === 'View' &&
        ((el.props as { className?: string }).className ?? '').includes('items-baseline')
    )[0];
    expect(textRow).toBeDefined();
    if (textRow == null) {
      throw new Error('expected the inner text row');
    }
    const textRowClassName = (textRow.props as { className?: string }).className ?? '';
    expect(textRowClassName).toContain('min-w-0');
    expect(textRowClassName).toContain('shrink');
    const texts = findAll(root, el => el.type === 'Text');
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      // The row shrinks, but the texts inside it keep RN's default
      // flexShrink: 0 unless they opt in too, so a squeezed row can never
      // compress them and the second text paints past the pill's right edge.
      const textClassName = (text.props as { className?: string }).className ?? '';
      expect(textClassName).toContain('shrink');
      expect(textClassName).toContain('min-w-0');
      expect((text.props as { numberOfLines?: number }).numberOfLines).toBe(1);
    }
  });

  it('messages with neither info nor cost keep the placeholder beside the track-only ring', () => {
    const root = render({
      hasMessages: true,
      info: undefined,
      totalCostMicrodollars: null,
    });
    expect(root.type).toBe('View');
    const className = (root.props as { className?: string }).className ?? '';
    expect(className).not.toContain('opacity-0');
    expect(
      (root.props as { accessibilityElementsHidden?: boolean }).accessibilityElementsHidden
    ).toBeUndefined();
    // A transcript that reports neither usage nor cost keeps the ring alone:
    // there is no unresolved value to hold a slot for.
    expect(findAll(root, el => el.type === 'Text')).toHaveLength(0);
    const ring = findAll(root, el => el.type === 'ContextUsageRing')[0];
    expect(ring).toBeDefined();
    if (ring == null) {
      throw new Error('expected ContextUsageRing');
    }
    expect((ring.props as { arcFraction?: number }).arcFraction).toBe(0);
  });

  // A session that reports no usage yet keeps both value slots instead of a
  // bare ring, and its cost slot holds a loading bar at the label's width until
  // usage arrives, so the pill never grows a value out of a narrower pill.
  it('holds the value slots over the bare ring, with a loading bar until usage arrives', () => {
    const dashes = (root: React.ReactElement) =>
      findAll(root, el => el.type === 'Text').filter(el => {
        const children = (el.props as { children?: unknown }).children;
        return children === '—';
      });
    const bars = (root: React.ReactElement) => findAll(root, el => el.type === 'Skeleton');
    const onPress = vi.fn<() => void>();

    const settled = render({
      info: undefined,
      totalCostMicrodollars: null,
      hasMessages: false,
      onPress,
    });
    const props = settled.props as { accessibilityLabel?: string; className?: string };
    expect(props.accessibilityLabel).toContain('usage unavailable');
    expect(props.className ?? '').not.toContain('opacity-0');
    expect(dashes(settled)).toHaveLength(2);
    // A settled pill promises nothing that has not arrived, so no bar.
    expect(bars(settled)).toHaveLength(0);

    const loading = render({
      info: undefined,
      totalCostMicrodollars: null,
      hasMessages: false,
      loading: true,
      onPress,
    });
    expect((loading.props as { accessibilityLabel?: string }).accessibilityLabel).not.toContain(
      'usage unavailable'
    );
    // One dash for the unresolved context window, one bar where the cost
    // label will land: the pill reads as loading instead of as missing data.
    expect(dashes(loading)).toHaveLength(1);
    const loadingBars = bars(loading);
    expect(loadingBars).toHaveLength(1);
    const loadingBar = loadingBars[0];
    if (!loadingBar) {
      throw new Error('expected the cost loading bar');
    }
    const barClassName = (loadingBar.props as { className?: string }).className ?? '';
    expect(barClassName).toContain('w-8');
    // `muted` equals the pill's own `secondary` fill, so a default-tone bar
    // would paint nothing here.
    expect(barClassName).toContain('bg-muted-soft');
  });
});
