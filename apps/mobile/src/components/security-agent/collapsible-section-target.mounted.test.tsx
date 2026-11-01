/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// The CollapsibleSection header's own frame is its row's target. The control
// audit and assistive technology read a pressable's node rect, not a `hitSlop`,
// so the header has to reach the shared row floor on its own box, and it has to
// be the box that already holds the card's inset — a caller's padding must not
// slide the frame inside the card. That contract lives here rather than beside
// the motion suite, whose file is at its line budget.

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

const CARD_CLASSES = 'rounded-lg bg-secondary';
const HEADER_INSET = 'px-3 pt-3 pb-3';
const BODY_INSET = 'px-3 pb-3';
const SECTION_BODY = 'section body';

/** Any padding utility, which the card must not carry: the header owns it. */
const PADDING_UTILITY = /(?:^|\s)-?p[xytrblse]?-\S+/;

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

/** The disclosure box and, when the section is expanded, its body. */
function animatedBoxes(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('Animated.View' as ElementType);
}

function boxWithClass(renderer: ReactTestRenderer, className: string) {
  return animatedBoxes(renderer).find(node => String(node.props.className).includes(className));
}

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = undefined;
});

describe('CollapsibleSection header frame', () => {
  it('carries the row target and the card inset on the pressable itself', () => {
    const header = headerNode(mountSection());

    expect(header.props.className).toContain(ROW_TARGET_CLASS);
    expect(header.props.className).toContain(HEADER_INSET);
    // A `hitSlop` would leave the audited rect short of the touch region, which
    // is the gap this header closed.
    expect(header.props.hitSlop).toBeUndefined();
  });

  it('leaves the inset to the header, so the card carries no padding of its own', () => {
    const renderer = mountSection();

    const card = boxWithClass(renderer, CARD_CLASSES);
    expect(card).toBeDefined();
    expect(String(card?.props.className)).not.toMatch(PADDING_UTILITY);
  });

  it('keeps the header flush when a caller supplies its own card classes', () => {
    const callerClasses = 'mt-3 rounded-lg border border-border bg-card';
    const renderer = mountSection({ className: callerClasses });

    // The caller's classes land on the surface, and the header's frame keeps
    // its own inset: no caller padding can push the frame inside the card.
    expect(boxWithClass(renderer, callerClasses)).toBeDefined();
    expect(headerNode(renderer).props.className).toContain(ROW_TARGET_CLASS);
    expect(headerNode(renderer).props.className).toContain(HEADER_INSET);
    expect(String(boxWithClass(renderer, callerClasses)?.props.className)).not.toMatch(
      PADDING_UTILITY
    );
  });

  it('gives the expanded body the card horizontal and bottom inset', () => {
    const renderer = mountSection({ defaultExpanded: true });

    const body = boxWithClass(renderer, BODY_INSET);
    expect(body).toBeDefined();
    expect(String(body?.props.className)).toContain('gap-2');
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
});
