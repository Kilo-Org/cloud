import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { type SessionContextInfo } from '@/lib/session-context-info';

import { SessionContextMetrics } from './session-context-metrics';

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

function findAll(
  node: unknown,
  predicate: (el: React.ReactElement) => boolean
): React.ReactElement[] {
  const matches: React.ReactElement[] = [];

  function walk(value: unknown): void {
    if (value == null || typeof value === 'string' || typeof value === 'number') {
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
      return;
    }
    if (React.isValidElement(value)) {
      if (predicate(value)) {
        matches.push(value);
      }
      const props = value.props as { children?: unknown };
      walk(props.children);
    }
  }

  walk(node);
  return matches;
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

  it('empty session with interactive info and onPress stays a hidden reserved view', () => {
    const onPress = vi.fn(() => undefined);
    const root = render({
      hasMessages: false,
      info: info(),
      totalCostMicrodollars: 150_000,
      onPress,
    });
    expectHiddenReservedBox(root);
    const props = root.props as {
      onPress?: () => void;
      accessibilityRole?: string;
    };
    expect(props.onPress).toBeUndefined();
    expect(props.accessibilityRole).not.toBe('button');
  });
});
