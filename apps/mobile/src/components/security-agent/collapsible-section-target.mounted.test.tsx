/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// The CollapsibleSection header is a grouped row: the control audit and
// assistive technology read a pressable's node rect, not a `hitSlop`, so the
// header carries the shared row floor and the group's row inset on its own box,
// and it sits inside the section's `RowGroup` surface. The expanded body sits on
// the page, not on the header's surface. That contract lives here rather than
// beside the motion suite, whose file is at its line budget.

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

const GROUP_SURFACE_CLASS = 'rounded-xl bg-secondary';
const HEADER_INSET = 'px-4 py-3';
const BODY_FRAME = 'gap-3 pt-3';
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

/** The disclosure box and, when the section is expanded, its body. */
function animatedBoxes(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('Animated.View' as ElementType);
}

/** The one box that carries the section's group surface. */
function groupSurface(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType('View' as ElementType)
    .find(node => String(node.props.className).includes(GROUP_SURFACE_CLASS));
}

/** The expanded body, whose frame the section owns. */
function bodyNode(renderer: ReactTestRenderer) {
  return animatedBoxes(renderer).find(node =>
    String(node.props.className).includes(BODY_FRAME)
  );
}

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = undefined;
});

describe('CollapsibleSection header frame', () => {
  it('carries the row target and the group row inset on the pressable itself', () => {
    const header = headerNode(mountSection());

    expect(header.props.className).toContain(ROW_TARGET_CLASS);
    expect(header.props.className).toContain(HEADER_INSET);
    // A `hitSlop` would leave the audited rect short of the touch region, which
    // is the gap this header closed.
    expect(header.props.hitSlop).toBeUndefined();
  });

  it('draws the header on the section group surface', () => {
    const renderer = mountSection();

    expect(groupSurface(renderer)).toBeDefined();
  });

  it('keeps the header frame when a caller supplies its own classes', () => {
    const callerClasses = 'mt-3 rounded-lg border border-border bg-card';
    const renderer = mountSection({ className: callerClasses });

    expect(String(headerNode(renderer).props.className)).toContain(ROW_TARGET_CLASS);
    expect(String(headerNode(renderer).props.className)).toContain(HEADER_INSET);
  });

  it('puts the expanded body on the page with the section frame', () => {
    const renderer = mountSection({ defaultExpanded: true });

    expect(String(bodyNode(renderer)?.props.className)).toContain(BODY_FRAME);
  });

  it('keeps the caller content classes on the expanded body', () => {
    const renderer = mountSection({ defaultExpanded: true, contentClassName: 'gap-1' });

    expect(String(bodyNode(renderer)?.props.className)).toContain('gap-1');
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
