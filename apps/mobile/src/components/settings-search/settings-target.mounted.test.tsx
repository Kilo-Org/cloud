import {
  createElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
  StrictMode,
} from 'react';
import { type ScrollViewInstance } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { defineSetting } from '@/lib/settings-search/definitions';
import {
  SettingsSearchScrollView,
  SettingsSearchTargetScope,
  SettingsTarget,
} from './settings-target';

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
const signOut = defineSetting('profile.signOut', 'common.signOut', 'signOut');

let renderer: ReactTestRenderer | undefined = undefined;

/** A ref holding a test double: the reveal path reads only its three members. */
function scrollTarget(instance: unknown): RefObject<ScrollViewInstance | null> {
  return { current: instance as ScrollViewInstance };
}

function mount(element: ReactElement) {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (renderer === undefined) {
    throw new Error('Missing renderer');
  }
  return renderer.root;
}

function update(element: ReactElement) {
  if (renderer === undefined) {
    throw new Error('Missing renderer');
  }
  act(() => {
    renderer?.update(element);
  });
}

function row(testID = 'row') {
  return createElement('Row', { testID });
}

function overlays(root: ReactTestInstance) {
  return root.findAll(
    node => Object.is(node.type, 'View') && String(node.props.className).includes('border-primary')
  );
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  fake.state.top = 40;
  fake.state.contentHeight = 0;
  fake.state.frameHeight = 0;
  fake.state.offset = 0;
  fake.scroll.scrollTo.mockClear();
});

/** The wrapper the active row draws around itself. */
function wrapper(root: ReactTestInstance) {
  return root.findAll(
    node => Object.is(node.type, 'View') && node.props.className === 'relative'
  )[0];
}

/** Fire the layout pass that registers the active row for its one reveal. */
function layout(node: ReactTestInstance | undefined) {
  act(() => {
    (node?.props.onLayout as (() => void) | undefined)?.();
  });
}

/** The scroller's committed content size, as its post-layout report. */
function contentSize(root: ReactTestInstance, height: number) {
  fake.state.contentHeight = height;
  const handler = root.findByType('TabScroll').props.onContentSizeChange as
    | ((width: number, height: number) => void)
    | undefined;
  act(() => {
    handler?.(0, height);
  });
}

/** The scroller's committed viewport frame. */
function frame(root: ReactTestInstance, height: number) {
  fake.state.frameHeight = height;
  const handler = root.findByType('TabScroll').props.onLayout as
    | ((event: { nativeEvent: { layout: { height: number } } }) => void)
    | undefined;
  act(() => {
    handler?.({ nativeEvent: { layout: { height } } });
  });
}

describe('SettingsTarget', () => {
  it('returns the row untouched without an active target scope', () => {
    const root = mount(<SettingsTarget item={system}>{row('alone')}</SettingsTarget>);

    expect(root.findByProps({ testID: 'alone' })).toBeTruthy();
    expect(root.findAll(node => Object.is(node.type, 'View'))).toEqual([]);
    expect(overlays(root)).toEqual([]);
  });

  it('reveals and highlights the matching row once, without changing its node', () => {
    const root = mount(
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
    const root = mount(
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
    const root = mount(
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
    const root = mount(
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
    const root = mount(
      <SettingsSearchScrollView contentContainerClassName="gap-6">
        <SettingsTarget item={dark}>{row()}</SettingsTarget>
      </SettingsSearchScrollView>
    );

    expect(root.findByProps({ testID: 'row' })).toBeTruthy();
    expect(overlays(root)).toEqual([]);
  });

  it('reveals the selected row against the body that replaces the results', () => {
    const action = vi.fn();
    const body = (target?: string) => (
      <SettingsSearchScrollView settingsTarget={target}>
        {target === undefined ? (
          row('results')
        ) : (
          <SettingsTarget item={signOut}>
            {createElement('Pressable', { testID: 'signOut', onPress: action })}
          </SettingsTarget>
        )}
      </SettingsSearchScrollView>
    );

    const root = mount(body());
    contentSize(root, 200);
    frame(root, 800);
    expect(fake.state.offset).toBe(0);

    fake.state.top = 900;
    update(body('profile.signOut'));
    // The replacing body's row lays out while the scroller still holds the
    // short results body, so the dispatch is clamped to the top — the Android
    // failure this regression pins.
    layout(wrapper(root));
    expect(fake.state.offset).toBe(0);

    // The taller body reports its size after the row's layout; the reveal is
    // re-measured against it instead of staying clamped at the top.
    contentSize(root, 2000);
    expect(fake.state.offset).toBe(888);
    expect(action).not.toHaveBeenCalled();
  });

  it('reveals the same row again when a repeated selection bumps the key', () => {
    fake.state.top = 900;
    const body = (revealKey?: number) => (
      <SettingsSearchScrollView settingsTarget="profile.signOut" revealKey={revealKey}>
        <SettingsTarget item={signOut}>{row('signOut')}</SettingsTarget>
      </SettingsSearchScrollView>
    );

    const root = mount(body());
    contentSize(root, 2000);
    frame(root, 800);
    layout(wrapper(root));
    expect(fake.state.offset).toBe(888);

    // The person scrolls away; a second tap on the same result must bring the
    // row back even though the target id never changed.
    fake.state.offset = 0;
    update(body(1));
    expect(fake.state.offset).toBe(888);
  });

  it('reveals a re-mounted row for the same id after the search body replaced it', () => {
    fake.state.top = 900;
    const body = (searching: boolean) => (
      <SettingsSearchScrollView settingsTarget="profile.signOut">
        {searching ? (
          row('results')
        ) : (
          <SettingsTarget item={signOut}>{row('signOut')}</SettingsTarget>
        )}
      </SettingsSearchScrollView>
    );

    const root = mount(body(false));
    contentSize(root, 2000);
    frame(root, 800);
    layout(wrapper(root));
    expect(fake.state.offset).toBe(888);

    // A new search replaces the full body, so the row unmounts while the
    // selected id stays.
    update(body(true));
    contentSize(root, 200);
    fake.state.offset = 0;

    // Selecting the same result again mounts a new row. The retained id must
    // not suppress its reveal.
    update(body(false));
    contentSize(root, 2000);
    layout(wrapper(root));
    expect(fake.state.offset).toBe(888);
  });

  it('reveals under StrictMode, whose simulated cleanup runs before the remount', () => {
    const root = mount(
      <StrictMode>
        <SettingsSearchScrollView settingsTarget="profile.signOut">
          <SettingsTarget item={signOut}>{row('signOut')}</SettingsTarget>
        </SettingsSearchScrollView>
      </StrictMode>
    );

    layout(wrapper(root));
    expect(fake.scroll.scrollTo).toHaveBeenCalledWith({ y: 28, animated: true });
  });

  it('does not jump back to a settled row when a section below it grows', () => {
    fake.state.top = 900;
    const root = mount(
      <SettingsSearchScrollView settingsTarget="profile.signOut">
        <SettingsTarget item={signOut}>{row('signOut')}</SettingsTarget>
      </SettingsSearchScrollView>
    );

    contentSize(root, 2000);
    frame(root, 800);
    layout(wrapper(root));
    expect(fake.state.offset).toBe(888);

    // The row has not moved and the reveal was not clamped, so a taller body
    // below it must not pull the screen back to the row.
    const calls = fake.scroll.scrollTo.mock.calls.length;
    contentSize(root, 2400);
    expect(fake.scroll.scrollTo).toHaveBeenCalledTimes(calls);
    expect(fake.state.offset).toBe(888);
  });

  it('re-measures when the viewport frame settles after the first reveal', () => {
    fake.state.top = 900;
    const root = mount(
      <SettingsSearchScrollView settingsTarget="profile.signOut">
        <SettingsTarget item={signOut}>{row('signOut')}</SettingsTarget>
      </SettingsSearchScrollView>
    );

    contentSize(root, 1000);
    // The scroller's first frame is measured against the shorter body, so the
    // dispatch stops at the range available then, short of the row's offset.
    frame(root, 300);
    layout(wrapper(root));
    expect(fake.state.offset).toBe(700);

    // A later keyboard frame changes the scrollable range; the same row must be
    // revealed against the final frame instead of staying where the first one
    // stopped it.
    frame(root, 100);
    expect(fake.state.offset).toBe(888);

    // Later frame reports at the settled height must not move the screen again.
    const calls = fake.scroll.scrollTo.mock.calls.length;
    frame(root, 100);
    expect(fake.scroll.scrollTo).toHaveBeenCalledTimes(calls);
  });
});
