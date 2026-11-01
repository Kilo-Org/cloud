/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// The CollapsibleSection header's own frame is its row's target. The control
// audit and assistive technology read a pressable's node rect, not a `hitSlop`,
// so the header has to reach the shared row floor on its own box — the card's
// own inset included. That contract lives here rather than beside the motion
// suite, whose file is at its line budget.

import { type ComponentProps, type ElementType, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { CollapsibleSection } from './collapsible-section';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(' '),
}));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: false, scrollAnimated: true }),
  selectReducedMotionEntrance: <T,>(_reducedMotion: boolean, entrance: T) => entrance,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withTiming: (value: number) => value,
  FadeIn: { duration: (ms: number) => ms },
  LinearTransition: { duration: (ms: number) => ms },
}));

const SECTION_BODY = 'section body';

let mounted: ReactTestRenderer | undefined = undefined;

function mountSection(
  props: Partial<Omit<ComponentProps<typeof CollapsibleSection>, 'children'>> = {},
  children: ReactNode = SECTION_BODY
): ReactTestRenderer {
  act(() => {
    mounted = TestRenderer.create(
      <CollapsibleSection title="Source" {...props}>
        {children}
      </CollapsibleSection>
    );
  });
  if (!mounted) {
    throw new Error('CollapsibleSection did not mount');
  }
  return mounted;
}

function headerNode(renderer: ReactTestRenderer) {
  return renderer.root.findByType('Pressable' as ElementType);
}

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = undefined;
});

describe('CollapsibleSection header frame', () => {
  it('carries the row target and the card inset on the pressable itself', () => {
    const header = headerNode(mountSection());

    // The negative margins reach the card's edges and the padding beside them
    // puts the same inset back inside the box, so the whole row a reader sees
    // is the row the frame covers; a `hitSlop` would leave the audited rect
    // short, so there is none.
    expect(header.props.className).toContain(ROW_TARGET_CLASS);
    expect(header.props.className).toContain('-mx-3');
    expect(header.props.className).toContain('px-3');
    expect(header.props.hitSlop).toBeUndefined();
  });

  it('keeps the button role, the title as its name, and the expanded state', () => {
    const renderer = mountSection();

    expect(headerNode(renderer).props.accessibilityRole).toBe('button');
    expect(headerNode(renderer).props.accessibilityLabel).toBe('Source');
    expect(headerNode(renderer).props.accessibilityState).toEqual({ expanded: false });

    act(() => {
      (headerNode(renderer).props.onPress as () => void)();
    });

    expect(headerNode(renderer).props.accessibilityState).toEqual({ expanded: true });
  });

  it('spans the card for a section whose caller supplies its own padding', () => {
    const header = headerNode(
      mountSection({ className: 'mt-3 rounded-lg border border-border bg-card p-4' })
    );

    expect(header.props.className).toContain(ROW_TARGET_CLASS);
    expect(header.props.hitSlop).toBeUndefined();
  });
});
