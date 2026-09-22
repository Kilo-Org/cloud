import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { type SessionContextInfo } from '@/lib/session-context-info';

import { SessionContextMetrics } from './session-context-metrics';
import { findAll } from './session-context-metrics-test-helpers';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./context-usage-ring', () => ({ ContextUsageRing: 'ContextUsageRing' }));

function info(partial: Partial<SessionContextInfo> = {}): SessionContextInfo {
  return {
    contextTokens: 32_418,
    providerID: 'kilo',
    modelID: 'anthropic/claude-sonnet-4',
    contextWindow: 200_000,
    percentage: 16,
    ...partial,
  };
}

function render(props: React.ComponentProps<typeof SessionContextMetrics>): React.ReactElement {
  // eslint-disable-next-line new-cap
  return SessionContextMetrics(props) as React.ReactElement;
}

const PILL_LAYOUT_TOKENS = [
  'h-[44px]',
  'flex-row',
  'items-center',
  'gap-2',
  'rounded-full',
  'border',
  'border-border',
  'bg-secondary',
  'px-3',
  // The header row hands the trailing cluster a capped 50% box, but RN's
  // default flexShrink is 0. Without these the pill keeps its natural width
  // and paints past the row's right edge instead of compressing.
  'shrink',
  'min-w-0',
] as const;

function expectHiddenReservedBox(root: React.ReactElement): void {
  expect(root.type).toBe('View');
  const className = (root.props as { className?: string }).className ?? '';
  expect(className).toContain('opacity-0');
  for (const token of PILL_LAYOUT_TOKENS) {
    expect(className).toContain(token);
  }
  expect(findAll(root, el => el.type === 'ContextUsageRing').length).toBeGreaterThan(0);
  const props = root.props as {
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
  };
  expect(props.accessibilityElementsHidden).toBe(true);
  expect(props.importantForAccessibility).toBe('no');
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

  it('messages with neither info nor cost show a visible track-only ring', () => {
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
    expect(findAll(root, el => el.type === 'Text')).toHaveLength(0);
    const ring = findAll(root, el => el.type === 'ContextUsageRing')[0];
    expect(ring).toBeDefined();
    if (ring == null) {
      throw new Error('expected ContextUsageRing');
    }
    expect((ring.props as { arcFraction?: number }).arcFraction).toBe(0);
  });
});
