/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Disclosure contract for the fixed session goal row: the row keeps the
// status in both states, hides the objective and the reason when collapsed,
// exposes a sibling disclosure pressable whose label and accessibility state
// follow the state, keeps the tuned top padding, and rotates the chevron with
// a 200ms timing that the reduced-motion policy turns into an instant jump.

import { type ComponentProps, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { SessionGoalSection } from './session-goal-section';

const policy = vi.hoisted(() => ({ reducedMotion: false }));
const reanimated = vi.hoisted(() => ({
  withTiming: vi.fn((value: number, config: unknown) => ({ __timing: true, value, config })),
  sharedValues: [] as { value: unknown }[],
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown', CircleDot: 'CircleDot' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#07f', mutedForeground: '#666' }),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(' '),
}));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({
    reducedMotion: policy.reducedMotion,
    scrollAnimated: !policy.reducedMotion,
  }),
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
  LinearTransition: { duration: (ms: number) => ({ __linearTransition: ms }) },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const OBJECTIVE = 'Ship the goal row';
const REASON = 'Waiting on the review';
const STATUS_TEXT = 'agentChat.goal.statusPaused';
const ROW_LABEL = 'agentChat.goal.sectionAccessibility';
const COLLAPSE_LABEL = 'agentChat.goal.collapse';
const EXPAND_LABEL = 'agentChat.goal.expand';

let mounted: ReactTestRenderer | undefined = undefined;
const onToggleCollapsed = vi.fn<() => void>();

function mountSection(
  props: Partial<Omit<ComponentProps<typeof SessionGoalSection>, 'goal'>> = {}
): ReactTestRenderer {
  act(() => {
    mounted = TestRenderer.create(
      <SessionGoalSection
        goal={{ text: OBJECTIVE, status: 'paused', reason: REASON }}
        collapsed={false}
        onToggleCollapsed={onToggleCollapsed}
        onPress={vi.fn<() => void>()}
        {...props}
      />
    );
  });
  if (!mounted) {
    throw new Error('SessionGoalSection did not mount');
  }
  return mounted;
}

function rowContainer(renderer: ReactTestRenderer) {
  return renderer.root.find(
    node =>
      node.type === ('View' as ElementType) && String(node.props.className).includes('min-h-12')
  );
}

/** The disclosure pressable is the only one carrying an accessibility state. */
function disclosure(renderer: ReactTestRenderer) {
  return renderer.root.find(
    node =>
      node.type === ('Pressable' as ElementType) && node.props.accessibilityState !== undefined
  );
}

function rowAction(renderer: ReactTestRenderer) {
  return renderer.root.find(
    node =>
      node.type === ('Pressable' as ElementType) && node.props.accessibilityState === undefined
  );
}

function renderedText(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as ElementType)
    .map(node => String(node.props.children));
}

function animatedViews(renderer: ReactTestRenderer) {
  return renderer.root.findAll(node => node.type === ('Animated.View' as ElementType));
}

/** The nearest host element above a node: `parent` alone lands on a component. */
function hostAncestor(node: ReactTestInstance): ReactTestInstance | null {
  let current = node.parent;
  while (current != null && typeof current.type !== 'string') {
    current = current.parent;
  }
  return current;
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

describe('SessionGoalSection disclosure', () => {
  beforeEach(() => {
    policy.reducedMotion = false;
    reanimated.sharedValues = [];
    reanimated.withTiming.mockClear();
    onToggleCollapsed.mockClear();
  });

  afterEach(() => {
    act(() => mounted?.unmount());
    mounted = undefined;
  });

  it('keeps the tuned top padding and drops the symmetric py-2', () => {
    const renderer = mountSection();

    expect(rowContainer(renderer).props.className).toContain('pt-0.5');
    expect(rowContainer(renderer).props.className).toContain('pb-2');
    expect(rowContainer(renderer).props.className).not.toContain('py-2');
    expect(rowContainer(renderer).props.className).toContain('min-h-12');
  });

  it('stretches the row action across the row height so the whole row opens the goal', () => {
    const renderer = mountSection({ collapsed: true });

    const classes = String(rowAction(renderer).props.className);
    expect(classes).toContain('self-stretch');
    expect(classes).toContain('items-start');
  });

  it('renders the status, the objective, and the reason when expanded', () => {
    const renderer = mountSection({ collapsed: false });

    expect(renderedText(renderer)).toEqual([STATUS_TEXT, OBJECTIVE, REASON]);
    expect(disclosure(renderer).props.accessibilityLabel).toBe(COLLAPSE_LABEL);
    expect(disclosure(renderer).props.accessibilityState).toEqual({ expanded: true });
    expect(disclosure(renderer).props.hitSlop).toBe(12);
    expect(rowAction(renderer).props.accessibilityLabel).toBe(ROW_LABEL);
  });

  it('renders the status only when collapsed', () => {
    const renderer = mountSection({ collapsed: true });

    expect(renderedText(renderer)).toEqual([STATUS_TEXT]);
    expect(disclosure(renderer).props.accessibilityLabel).toBe(EXPAND_LABEL);
    expect(disclosure(renderer).props.accessibilityState).toEqual({ expanded: false });
    expect(rowAction(renderer).props.accessibilityLabel).toBe(STATUS_TEXT);
  });

  it('keeps the disclosure as a sibling of the row action', () => {
    const renderer = mountSection();
    const pressables = renderer.root.findAll(node => node.type === ('Pressable' as ElementType));

    expect(pressables).toHaveLength(2);
    // The carat is its own pressable under the row, a sibling of the action
    // pressable rather than nested inside it: a nested pressable disappears
    // from assistive technology inside an accessible parent.
    expect(hostAncestor(disclosure(renderer))).toBe(rowContainer(renderer));
    expect(hostAncestor(rowAction(renderer))).toBe(rowContainer(renderer));
  });

  it('calls onToggleCollapsed from the disclosure pressable', () => {
    const renderer = mountSection();
    const pressable = disclosure(renderer);

    act(() => {
      (pressable.props.onPress as () => void)();
    });

    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('targets 180deg collapsed and 0deg expanded with the 200ms timing', () => {
    const expanded = mountSection({ collapsed: false });
    expect(reanimated.withTiming).toHaveBeenCalledWith(0, { duration: 200 });
    expect(animatedViews(expanded)[0]?.props.layout).toEqual({ __linearTransition: 200 });
    act(() => mounted?.unmount());

    reanimated.sharedValues = [];
    reanimated.withTiming.mockClear();

    mountSection({ collapsed: true });
    expect(reanimated.withTiming).toHaveBeenCalledWith(180, { duration: 200 });
    expect(rotationValue()).toEqual({ __timing: true, value: 180, config: { duration: 200 } });
  });

  it('rotates instantly and drops the layout transition under reduced motion', () => {
    policy.reducedMotion = true;
    const renderer = mountSection({ collapsed: false });

    expect(reanimated.withTiming).not.toHaveBeenCalled();
    expect(rotationValue()).toBe(0);
    expect(animatedViews(renderer)[0]?.props.layout).toBeUndefined();

    act(() => mounted?.unmount());
    reanimated.sharedValues = [];

    mountSection({ collapsed: true });
    expect(reanimated.withTiming).not.toHaveBeenCalled();
    expect(rotationValue()).toBe(180);
  });
});
