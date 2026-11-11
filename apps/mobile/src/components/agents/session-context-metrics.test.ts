/* eslint-disable max-lines -- one case per pill state: permission controls, the reserved box, the hugging content and the loading bar share these render helpers. */
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { formatPercent } from '@/lib/format';

import { formatSessionCostBadge } from './session-list-helpers';
import { WIDEST_COST_MICRODOLLARS, WIDEST_PERCENTAGE_VALUE } from './session-context-metrics';
import {
  classNameOf,
  expectHiddenReservedBox,
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
    expectHiddenReservedBox(
      render({
        info: undefined,
        totalCostMicrodollars: null,
        hasMessages: false,
      })
    );
  });

  it('empty session with a cost stays fully hidden', () => {
    expectHiddenReservedBox(
      render({
        info: undefined,
        totalCostMicrodollars: 150_000,
        hasMessages: false,
      })
    );
  });

  it('loading keeps the reserved invisible box', () => {
    expectHiddenReservedBox(
      render({
        loading: true,
        hasMessages: true,
        info: undefined,
        totalCostMicrodollars: null,
      })
    );
  });

  it('loading wins over missing messages', () => {
    expectHiddenReservedBox(
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
  // so the pill, its reading and the box around it must all opt in or they
  // paint off-screen.
  it('lets the pill and its reading compress inside a constrained header row', () => {
    const root = render({
      hasMessages: true,
      info: info(),
      totalCostMicrodollars: 150_000,
      onPress: vi.fn<() => void>(),
    });
    expect(classNameOf(root)).toContain('min-w-0');
    expect(classNameOf(root)).toContain('shrink');
    expect(classNameOf(root)).toContain('items-end');
    const pill = pillOf(root);
    const runs = findAll(pill, el => propsOf(el).numberOfLines === 1);
    expect(runs).toHaveLength(1);
    for (const run of runs) {
      expect(classNameOf(run)).toContain('shrink');
      expect(classNameOf(run)).toContain('min-w-0');
    }
  });

  // A transcript that reports no usage and no cost paints a bare ring: the pill
  // hugs what it holds instead of holding a value slot open for a reading that
  // will never arrive.
  it('paints only the ring when there is no value to show', () => {
    const root = render({ hasMessages: true, info: undefined, totalCostMicrodollars: null });
    const pill = pillOf(root);
    expect(propsOf(pill).className ?? '').not.toContain('opacity-0');
    expect(propsOf(pill).accessibilityElementsHidden).toBeUndefined();
    // The only texts in the pill are the hidden sizers of the reserve, which
    // paint nothing and stay out of the reading.
    for (const text of findAll(pill, el => el.type === 'Text')) {
      expect(classNameOf(text)).toContain('opacity-0');
      expect(propsOf(text).accessibilityElementsHidden).toBe(true);
    }
    // Nothing paints beside the ring: the value run is absent, not reserved.
    expect(findAll(pill, el => el.type === 'ContextUsageRing')).toHaveLength(1);
    expect(
      findAll(pill, el => el.type === 'Text' && !classNameOf(el).includes('opacity-0'))
    ).toHaveLength(0);
  });

  // The reserve is a zero-height copy of the widest reading the pill can show, so
  // the box keeps one width while the pill paints only what arrived.
  it('reserves the widest reading without painting it', () => {
    const root = render({
      hasMessages: true,
      info: info(),
      totalCostMicrodollars: 150_000,
      onPress: vi.fn<() => void>(),
    });
    const percentageSizer = formatPercent(WIDEST_PERCENTAGE_VALUE, i18n.language);
    const costSizer = formatSessionCostBadge(WIDEST_COST_MICRODOLLARS);
    expect(costSizer).not.toBeNull();
    const reserved = findAll(root, el => classNameOf(el).includes('h-0'));
    expect(reserved).toHaveLength(1);
    const reserve = reserved[0] ?? root;
    expect(classNameOf(reserve)).toContain('overflow-hidden');
    const runs = findAll(reserve, el => propsOf(el).numberOfLines === 1);
    expect(runs).toHaveLength(1);
    expect(classNameOf(runs[0] ?? root)).toContain('opacity-0');
    expect(findAll(reserve, el => propsOf(el).children === percentageSizer)).toHaveLength(1);
    expect(findAll(reserve, el => propsOf(el).children === costSizer)).toHaveLength(1);
  });

  // No usage yet: the pill paints its dashes, and while loading one bar covers
  // the widest reading instead of a fixed width that fits only the default font
  // scale.
  it('paints the dashes while settled and one bar while loading', () => {
    const classOf = classNameOf;
    const textsWith = (root: React.ReactElement, text: string) =>
      findAll(root, el => propsOf(el).children === text);
    const bars = (root: React.ReactElement) => findAll(root, el => el.type === 'Skeleton');
    const onPress = vi.fn<() => void>();

    const bare = (loading = false) =>
      render({
        info: undefined,
        totalCostMicrodollars: null,
        hasMessages: false,
        loading,
        onPress,
      });
    const settled = pillOf(bare());
    expect(propsOf(settled).accessibilityLabel).toContain('usage unavailable');
    // The usage dash is a real reading: the session reported tokens but no
    // window to divide them by. The cost never arrived, so it paints nothing.
    expect(textsWith(settled, '—')).toHaveLength(1);
    for (const dash of textsWith(settled, '—')) {
      expect(classOf(dash)).not.toContain('opacity-0');
    }
    expect(bars(settled)).toHaveLength(0);

    const loading = pillOf(bare(true));
    expect(propsOf(loading).accessibilityLabel ?? '').not.toContain('usage unavailable');
    const hiddenRuns = findAll(
      loading,
      el => el.type === 'Text' && classOf(el).includes('opacity-0')
    );
    expect(hiddenRuns).toHaveLength(1);
    expect(textsWith(loading, '—')).toHaveLength(0);
    const [loadingBar] = bars(loading);
    // A box over the run, not a fixed width that fits only the default font scale.
    expect(classOf(loadingBar ?? loading)).toContain('w-full');
    expect(classOf(loadingBar ?? loading)).toContain('bg-muted-soft');
  });
});
