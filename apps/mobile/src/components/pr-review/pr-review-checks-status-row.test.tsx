import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type PrReviewChecksStatus, PrReviewChecksStatusRow } from './pr-review-checks-status-row';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: (ms: number) => ({ __fadeIn: ms }) },
  FadeOut: { duration: (ms: number) => ({ __fadeOut: ms }) },
  LinearTransition: { duration: (ms: number) => ({ __linearTransition: ms }) },
}));
vi.mock('@/components/ui/icons', () => ({
  CheckCircle2: 'CheckCircle2',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Loader2: 'Loader2',
  MinusCircle: 'MinusCircle',
  XCircle: 'XCircle',
}));
vi.mock('@/components/ui/spinning-icon', () => ({ SpinningIcon: 'SpinningIcon' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Carry both counts through, so the label assertion proves displayCount is
    // passed to the reused status key and that `count` rides along for a locale
    // that inflects.
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'displayCount' in options
        ? `${key}=${String(options.displayCount)}${'count' in options ? `/${String(options.count)}` : ''}`
        : key,
  }),
}));
vi.mock('@/i18n', () => ({ i18n: { language: 'en', t: (key: string) => key } }));
vi.mock('@/lib/format', () => ({ formatNumber: String }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    destructive: 'red',
    good: 'green',
    mutedForeground: 'gray',
  }),
}));

const STATUSES = ['success', 'failure', 'pending', 'skipped'] as const;

const EXPECTED = {
  success: {
    label: 'prReview.checks.passed=3/3',
    icon: 'CheckCircle2',
    spinning: false,
    color: 'green',
  },
  failure: {
    label: 'prReview.checks.failed=3/3',
    icon: 'XCircle',
    spinning: false,
    color: 'red',
  },
  pending: {
    label: 'prReview.checks.pending=3/3',
    icon: 'Loader2',
    spinning: true,
    color: 'gray',
  },
  skipped: {
    label: 'prReview.checks.skipped=3/3',
    icon: 'MinusCircle',
    spinning: false,
    color: 'gray',
  },
} as const;

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mountRow(status: PrReviewChecksStatus = 'success', count = 3, showSeparator = false) {
  act(() => {
    mounted = TestRenderer.create(
      <PrReviewChecksStatusRow status={status} count={count} showSeparator={showSeparator}>
        {createElement('Text', null, 'group body')}
      </PrReviewChecksStatusRow>
    );
  });
  const renderer = mounted;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function header(renderer: TestRenderer.ReactTestRenderer) {
  const pressable = renderer.root.findAll(node => String(node.type) === 'Pressable')[0];
  if (!pressable) {
    throw new Error('the status row header did not render');
  }
  return pressable;
}

function bodyNodes(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node => String(node.type) === 'Text' && node.props.children === 'group body'
  );
}

function toggle(renderer: TestRenderer.ReactTestRenderer) {
  const node = header(renderer);
  act(() => {
    (node.props.onPress as () => void)();
  });
}

afterEach(() => {
  act(() => {
    mounted?.unmount();
  });
  mounted = undefined;
});

describe('PrReviewChecksStatusRow', () => {
  it('collapses by default: no children, ChevronDown, expanded false', () => {
    const renderer = mountRow();

    expect(bodyNodes(renderer)).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'ChevronDown')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'ChevronUp')).toHaveLength(0);
    expect(header(renderer).props.accessibilityRole).toBe('button');
    expect(header(renderer).props.accessibilityState).toEqual({ expanded: false });
  });

  it('expands on press: children render, ChevronUp, expanded true', () => {
    const renderer = mountRow();

    toggle(renderer);

    expect(bodyNodes(renderer)).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'ChevronUp')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'ChevronDown')).toHaveLength(0);
    expect(header(renderer).props.accessibilityState).toEqual({ expanded: true });
  });

  it('collapses again on a second press', () => {
    const renderer = mountRow();

    toggle(renderer);
    toggle(renderer);

    expect(bodyNodes(renderer)).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'ChevronDown')).toHaveLength(1);
    expect(header(renderer).props.accessibilityState).toEqual({ expanded: false });
  });

  it('announces the label with the count through the accessibility label', () => {
    const renderer = mountRow('pending', 12);

    expect(header(renderer).props.accessibilityLabel).toBe('prReview.checks.pending=12/12');
  });

  it('draws the hairline only when it is not the last group row', () => {
    const withSeparator = mountRow('success', 1, true);
    expect(
      withSeparator.root.findAll(
        node =>
          typeof node.props.className === 'string' &&
          node.props.className.includes('border-b-[0.5px]')
      )
    ).toHaveLength(1);
    act(() => {
      withSeparator.unmount();
    });
    mounted = undefined;

    const withoutSeparator = mountRow('success', 1, false);
    expect(
      withoutSeparator.root.findAll(
        node =>
          typeof node.props.className === 'string' &&
          node.props.className.includes('border-b-[0.5px]')
      )
    ).toHaveLength(0);
  });

  it.each(STATUSES)('renders the %s row icon, spin state and label', status => {
    const expected = EXPECTED[status];
    const renderer = mountRow(status);
    const icons = renderer.root.findAll(node => String(node.type) === 'SpinningIcon');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.props.icon).toBe(expected.icon);
    expect(icons[0]?.props.spinning).toBe(expected.spinning);
    expect(icons[0]?.props.color).toBe(expected.color);
    expect(header(renderer).props.accessibilityLabel).toBe(expected.label);
  });

  it('spins only the pending row', () => {
    const spinning = STATUSES.map(status => {
      const renderer = mountRow(status);
      const icon = renderer.root.findAll(node => String(node.type) === 'SpinningIcon')[0];
      const value = icon?.props.spinning as boolean;
      act(() => {
        renderer.unmount();
      });
      mounted = undefined;
      return value;
    });
    expect(spinning).toEqual([false, false, true, false]);
  });
});
