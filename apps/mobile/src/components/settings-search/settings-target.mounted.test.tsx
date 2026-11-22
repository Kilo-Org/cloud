import { createElement, type ReactNode, type Ref } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defineSetting } from '@/lib/settings-search/definitions';
import {
  SettingsSearchScrollView,
  SettingsSearchTargetScope,
  SettingsTarget,
} from './settings-target';
import {
  createHarness,
  layout,
  overlays,
  resetScroll,
  row,
  scrollTarget,
  wrapper,
} from './settings-target.test-helpers';

const fake = vi.hoisted(() => {
  const content = { node: 'content' };
  // The scroller's committed geometry and offset. `scrollTo` clamps like the
  // native view does, so a dispatch that lands before the taller body commits
  // stops at the shorter body's range instead of pretending it scrolled.
  const state = { top: 40, contentHeight: 0, frameHeight: 0, offset: 0 };
  const scroll = {
    getInnerViewRef: () => content,
    getInnerViewNode: () => undefined,
    scrollTo: vi.fn(({ y }: { y: number }) => {
      const max = Math.max(0, state.contentHeight - state.frameHeight);
      state.offset = Math.min(Math.max(0, y), max);
    }),
  };
  return { content, state, scroll };
});

type RevealNode = {
  measureLayout: (relative: unknown, onSuccess: (left: number, top: number) => void) => void;
};

vi.mock('react-native', async () => {
  // A vi.mock factory is hoisted above the module's static imports, so React is
  // imported inside it. The reveal measures through the row wrapper's own ref,
  // so the mock hands that ref a real instance: a host string gives the
  // renderer's inert node, whose `measureLayout` never reports a frame.
  const react = await import('react');
  function MockView({
    ref,
    children,
    ...props
  }: { ref?: Ref<RevealNode>; children?: ReactNode } & Record<string, unknown>) {
    react.useImperativeHandle(
      ref,
      () => ({
        measureLayout: (_relative: unknown, onSuccess: (left: number, top: number) => void) => {
          onSuccess(0, fake.state.top);
        },
      }),
      []
    );
    return react.createElement('View', props, children);
  }
  return { View: MockView };
});
// Stands in for the wrapper: it hands the scope the instance the real scroll
// view's forwarded ref would hold, and records the props it received.
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: ({
    ref,
    children,
    ...props
  }: { ref?: { current: unknown } | null; children?: ReactNode } & Record<string, unknown>) => {
    if (ref != null) {
      ref.current = fake.scroll;
    }
    return createElement('TabScroll', props, children);
  },
}));

const system = defineSetting('appearance.system', 'preferences.appearanceSystem');
const dark = defineSetting('appearance.dark', 'preferences.appearanceDark');

const harness = createHarness();

afterEach(() => {
  harness.unmount();
  resetScroll(fake.state);
  fake.scroll.scrollTo.mockClear();
});

describe('SettingsTarget', () => {
  it('returns the row untouched without an active target scope', () => {
    const root = harness.mount(<SettingsTarget item={system}>{row('alone')}</SettingsTarget>);

    expect(root.findByProps({ testID: 'alone' })).toBeTruthy();
    expect(root.findAll(node => Object.is(node.type, 'View'))).toEqual([]);
    expect(overlays(root)).toEqual([]);
  });

  it('reveals and highlights the matching row once, without changing its node', () => {
    const root = harness.mount(
      <SettingsSearchTargetScope
        settingsTarget="appearance.dark"
        scrollRef={scrollTarget(fake.scroll)}
      >
        <SettingsTarget item={dark}>{row()}</SettingsTarget>
      </SettingsSearchTargetScope>
    );

    expect(root.findByProps({ testID: 'row' })).toBeTruthy();
    expect(overlays(root)).toHaveLength(1);
    const box = wrapper(root);
    expect(box?.props.accessibilityRole).toBeUndefined();
    expect(box?.props.accessible).toBeUndefined();

    layout(box);
    // A later layout pass must not scroll the screen back to the row.
    layout(box);
    expect(fake.scroll.scrollTo).toHaveBeenCalledTimes(1);
    expect(fake.scroll.scrollTo).toHaveBeenCalledWith({ y: 28, animated: true });
  });

  it('leaves a non-matching row and its group geometry alone', () => {
    const root = harness.mount(
      <SettingsSearchTargetScope
        settingsTarget="appearance.system"
        scrollRef={scrollTarget(fake.scroll)}
      >
        <SettingsTarget item={dark}>{row()}</SettingsTarget>
      </SettingsSearchTargetScope>
    );

    expect(root.findByProps({ testID: 'row' })).toBeTruthy();
    expect(overlays(root)).toEqual([]);
    expect(root.findAll(node => Object.is(node.type, 'View'))).toEqual([]);
    expect(fake.scroll.scrollTo).not.toHaveBeenCalled();
  });

  it('matches an alias id for a control shared by several definitions', () => {
    const root = harness.mount(
      <SettingsSearchTargetScope
        settingsTarget="appearance.dark"
        scrollRef={scrollTarget(fake.scroll)}
      >
        <SettingsTarget item={system} targetIds={['appearance.dark', 'appearance.light']}>
          {row()}
        </SettingsTarget>
      </SettingsSearchTargetScope>
    );

    expect(overlays(root)).toHaveLength(1);
  });
});

describe('SettingsSearchScrollView', () => {
  it('forwards tab-scroll props and the scroll ref while supplying the target', () => {
    const forwarded = scrollTarget(null);
    const root = harness.mount(
      <SettingsSearchScrollView
        settingsTarget="appearance.dark"
        ref={forwarded}
        contentContainerClassName="gap-6 px-4 pt-3"
        keyboardShouldPersistTaps="handled"
      >
        <SettingsTarget item={dark}>{row()}</SettingsTarget>
      </SettingsSearchScrollView>
    );

    const scroller = root.findByType('TabScroll');
    expect(scroller.props.contentContainerClassName).toBe('gap-6 px-4 pt-3');
    expect(scroller.props.keyboardShouldPersistTaps).toBe('handled');
    expect(forwarded.current).toBe(fake.scroll);
    expect(overlays(root)).toHaveLength(1);

    layout(wrapper(root));
    expect(fake.scroll.scrollTo).toHaveBeenCalledWith({ y: 28, animated: true });
  });

  it('renders the plain body when the route names no target', () => {
    const root = harness.mount(
      <SettingsSearchScrollView contentContainerClassName="gap-6">
        <SettingsTarget item={dark}>{row()}</SettingsTarget>
      </SettingsSearchScrollView>
    );

    expect(root.findByProps({ testID: 'row' })).toBeTruthy();
    expect(overlays(root)).toEqual([]);
  });
});
