/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Reduce-motion gate for the security-agent CollapsibleSection. When
// `useMotionPolicy()` reports reduced motion the chevron must jump to its
// target angle (no `withTiming`) and the panel must drop the `LinearTransition`
// layout animation and the content `FadeIn`; with normal motion the existing
// 200ms chevron timing, 200ms layout transition, and 150ms fade stay.

import { type ComponentProps, type ElementType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { CollapsibleSection } from './collapsible-section';

const policy = vi.hoisted(() => ({ reducedMotion: false }));
const reanimated = vi.hoisted(() => ({
  withTiming: vi.fn((value: number, config: unknown) => ({ __timing: true, value, config })),
  sharedValues: [] as { value: unknown }[],
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(' '),
}));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({
    reducedMotion: policy.reducedMotion,
    scrollAnimated: !policy.reducedMotion,
  }),
  selectReducedMotionEntrance: <T,>(reducedMotion: boolean, entrance: T) =>
    reducedMotion ? undefined : entrance,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useSharedValue: (value: unknown) => {
    const holder = { value };
    reanimated.sharedValues.push(holder);
    return holder;
  },
  useAnimatedStyle: () => ({}),
  withTiming: reanimated.withTiming,
  FadeIn: { duration: (ms: number) => ({ __fadeIn: ms }) },
  LinearTransition: { duration: (ms: number) => ({ __linearTransition: ms }) },
}));

const OUTER_CLASSES = 'gap-2 rounded-lg bg-secondary p-3';
const BODY_CLASSES = 'gap-2';
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

/** The single `Animated.View` rendered with the given resolved className. */
function animatedView(renderer: ReactTestRenderer, className: string) {
  return renderer.root.find(
    node => node.type === ('Animated.View' as ElementType) && node.props.className === className
  );
}

/** How many `Animated.View`s resolve to the given className (0 when collapsed). */
function animatedViewCount(renderer: ReactTestRenderer, className: string) {
  return renderer.root.findAll(
    node => node.type === ('Animated.View' as ElementType) && node.props.className === className
  ).length;
}

function title(renderer: ReactTestRenderer) {
  return renderer.root.findByType('Text' as ElementType);
}

function pressableNode(renderer: ReactTestRenderer) {
  return renderer.root.findByType('Pressable' as ElementType);
}

function toggle(renderer: ReactTestRenderer) {
  const pressable = renderer.root.findByType('Pressable' as ElementType);
  act(() => {
    (pressable.props.onPress as () => void)();
  });
  return pressable;
}

/** The rotation shared value is the only one the section creates; each render
 *  asks for it again, so the last holder belongs to the newest commit. */
function rotationValue(): unknown {
  const holder = reanimated.sharedValues.at(-1);
  if (!holder) {
    throw new Error('the section did not create a shared value');
  }
  return holder.value;
}

describe('CollapsibleSection reduce-motion gate', () => {
  beforeEach(() => {
    policy.reducedMotion = false;
    reanimated.sharedValues = [];
    reanimated.withTiming.mockClear();
  });

  afterEach(() => {
    act(() => mounted?.unmount());
    mounted = undefined;
  });

  it('drops the layout transition, content fade, and chevron timing under reduced motion', () => {
    policy.reducedMotion = true;
    const renderer = mountSection();

    expect(animatedView(renderer, OUTER_CLASSES).props.layout).toBeUndefined();
    expect(reanimated.withTiming).not.toHaveBeenCalled();
    expect(rotationValue()).toBe(0);

    toggle(renderer);
    expect(animatedView(renderer, 'gap-2').props.entering).toBeUndefined();
    expect(reanimated.withTiming).not.toHaveBeenCalled();
    expect(rotationValue()).toBe(180);

    // Collapsing jumps back without a timing animation.
    toggle(renderer);
    expect(reanimated.withTiming).not.toHaveBeenCalled();
    expect(rotationValue()).toBe(0);
  });

  it('applies the initial rotation from defaultExpanded without a timing animation', () => {
    policy.reducedMotion = true;
    const renderer = mountSection({ defaultExpanded: true });

    expect(rotationValue()).toBe(180);
    expect(reanimated.withTiming).not.toHaveBeenCalled();
    expect(animatedView(renderer, 'gap-2').props.entering).toBeUndefined();
  });

  it('keeps the 200ms timing, layout transition, and 150ms fade with normal motion', () => {
    policy.reducedMotion = false;
    const renderer = mountSection();

    expect(animatedView(renderer, OUTER_CLASSES).props.layout).toEqual({ __linearTransition: 200 });

    toggle(renderer);
    expect(animatedView(renderer, 'gap-2').props.entering).toEqual({ __fadeIn: 150 });
    expect(reanimated.withTiming).toHaveBeenCalledWith(180, { duration: 200 });
    expect(rotationValue()).toEqual({ __timing: true, value: 180, config: { duration: 200 } });

    toggle(renderer);
    expect(reanimated.withTiming).toHaveBeenLastCalledWith(0, { duration: 200 });
  });

  it('keeps the pressable accessibility contract under reduced motion', () => {
    policy.reducedMotion = true;
    const renderer = mountSection();

    const pressable = renderer.root.findByType('Pressable' as ElementType);
    expect(pressable.props.accessibilityRole).toBe('button');
    expect(pressable.props.accessibilityLabel).toBe('Source');
    expect(pressable.props.hitSlop).toBe(12);
    expect(pressable.props.accessibilityState).toEqual({ expanded: false });

    const toggled = toggle(renderer);
    expect(toggled.props.accessibilityState).toEqual({ expanded: true });
  });
});

describe('CollapsibleSection controlled expanded state and class overrides', () => {
  beforeEach(() => {
    policy.reducedMotion = false;
    reanimated.sharedValues = [];
    reanimated.withTiming.mockClear();
  });

  afterEach(() => {
    act(() => mounted?.unmount());
    mounted = undefined;
  });

  it('renders the controlled value and only the parent can change it', () => {
    const onToggle = vi.fn<() => void>();
    const renderer = mountSection({ expanded: true, onToggle });

    expect(title(renderer).props.children).toBe('Source');
    expect(pressableNode(renderer).props.accessibilityState).toEqual({ expanded: true });
    expect(animatedViewCount(renderer, BODY_CLASSES)).toBe(1);

    // A press notifies the parent but leaves the rendered state where the
    // parent put it — the section never flips its own controlled state.
    toggle(renderer);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(pressableNode(renderer).props.accessibilityState).toEqual({ expanded: true });
    expect(animatedViewCount(renderer, BODY_CLASSES)).toBe(1);

    // The parent flipping the prop is what collapses the section.
    act(() => {
      renderer.update(
        <CollapsibleSection title="Source" expanded={false} onToggle={onToggle}>
          {SECTION_BODY}
        </CollapsibleSection>
      );
    });
    expect(pressableNode(renderer).props.accessibilityState).toEqual({ expanded: false });
    expect(animatedViewCount(renderer, BODY_CLASSES)).toBe(0);
    expect(title(renderer).props.children).toBe('Source');
  });

  it('keeps the title and reports collapsed for expanded={false}', () => {
    const renderer = mountSection({ expanded: false });

    // Collapsed means reduced, never deleted: the title row stays.
    expect(title(renderer).props.children).toBe('Source');
    expect(pressableNode(renderer).props.accessibilityState).toEqual({ expanded: false });
    expect(animatedViewCount(renderer, BODY_CLASSES)).toBe(0);
  });

  it('merges titleClassName and contentClassName through cn', () => {
    const renderer = mountSection({
      expanded: true,
      titleClassName: 'text-base font-semibold',
      contentClassName: 'bg-card p-4 gap-3',
    });

    expect(title(renderer).props.className).toBe(
      'flex-1 text-sm font-medium text-base font-semibold'
    );
    expect(animatedView(renderer, 'gap-2 bg-card p-4 gap-3')).toBeDefined();
  });
});
