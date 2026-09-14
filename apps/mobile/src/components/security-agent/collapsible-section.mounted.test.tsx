// Reduce-motion gate for the security-agent CollapsibleSection. When
// `useMotionPolicy()` reports reduced motion the chevron must jump to its
// target angle (no `withTiming`) and the panel must drop the `LinearTransition`
// layout animation and the content `FadeIn`; with normal motion the existing
// 200ms chevron timing, 200ms layout transition, and 150ms fade stay.

import { type ComponentProps, type ElementType, type ReactNode } from 'react';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

let mounted: ReactTestRenderer | undefined = undefined;

function mountSection(
  props: Partial<Omit<ComponentProps<typeof CollapsibleSection>, 'children'>> = {},
  children: ReactNode = 'section body'
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
