import { createElement, type ReactNode, type Ref, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defineSetting } from '@/lib/settings-search/definitions';
import { SettingsSearchScrollView, SettingsTarget } from './settings-target';
import {
  contentSize,
  createHarness,
  frame,
  layout,
  resetScroll,
  row,
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

const signOut = defineSetting('profile.signOut', 'common.signOut', 'signOut');

const harness = createHarness();

afterEach(() => {
  harness.unmount();
  resetScroll(fake.state);
  fake.scroll.scrollTo.mockClear();
});

describe('SettingsSearchScrollView reveal', () => {
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

    const root = harness.mount(body());
    contentSize(root, fake.state, 200);
    frame(root, fake.state, 800);
    expect(fake.state.offset).toBe(0);

    fake.state.top = 900;
    harness.update(body('profile.signOut'));
    // The replacing body's row lays out while the scroller still holds the
    // short results body, so the dispatch is clamped to the top — the Android
    // failure this regression pins.
    layout(wrapper(root));
    expect(fake.state.offset).toBe(0);

    // The taller body reports its size after the row's layout; the reveal is
    // re-measured against it instead of staying clamped at the top.
    contentSize(root, fake.state, 2000);
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

    const root = harness.mount(body());
    contentSize(root, fake.state, 2000);
    frame(root, fake.state, 800);
    layout(wrapper(root));
    expect(fake.state.offset).toBe(888);

    // The person scrolls away; a second tap on the same result must bring the
    // row back even though the target id never changed.
    fake.state.offset = 0;
    harness.update(body(1));
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

    const root = harness.mount(body(false));
    contentSize(root, fake.state, 2000);
    frame(root, fake.state, 800);
    layout(wrapper(root));
    expect(fake.state.offset).toBe(888);

    // A new search replaces the full body, so the row unmounts while the
    // selected id stays.
    harness.update(body(true));
    contentSize(root, fake.state, 200);
    fake.state.offset = 0;

    // Selecting the same result again mounts a new row. The retained id must
    // not suppress its reveal.
    harness.update(body(false));
    contentSize(root, fake.state, 2000);
    layout(wrapper(root));
    expect(fake.state.offset).toBe(888);
  });

  it('reveals under StrictMode, whose simulated cleanup runs before the remount', () => {
    const root = harness.mount(
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
    const root = harness.mount(
      <SettingsSearchScrollView settingsTarget="profile.signOut">
        <SettingsTarget item={signOut}>{row('signOut')}</SettingsTarget>
      </SettingsSearchScrollView>
    );

    contentSize(root, fake.state, 2000);
    frame(root, fake.state, 800);
    layout(wrapper(root));
    expect(fake.state.offset).toBe(888);

    // The row has not moved and the reveal was not clamped, so a taller body
    // below it must not pull the screen back to the row.
    const calls = fake.scroll.scrollTo.mock.calls.length;
    contentSize(root, fake.state, 2400);
    expect(fake.scroll.scrollTo).toHaveBeenCalledTimes(calls);
    expect(fake.state.offset).toBe(888);
  });

  it('re-measures when the viewport frame settles after the first reveal', () => {
    fake.state.top = 900;
    const root = harness.mount(
      <SettingsSearchScrollView settingsTarget="profile.signOut">
        <SettingsTarget item={signOut}>{row('signOut')}</SettingsTarget>
      </SettingsSearchScrollView>
    );

    contentSize(root, fake.state, 1000);
    // The scroller's first frame is measured against the shorter body, so the
    // dispatch stops at the range available then, short of the row's offset.
    frame(root, fake.state, 300);
    layout(wrapper(root));
    expect(fake.state.offset).toBe(700);

    // A later keyboard frame changes the scrollable range; the same row must be
    // revealed against the final frame instead of staying where the first one
    // stopped it.
    frame(root, fake.state, 100);
    expect(fake.state.offset).toBe(888);

    // Later frame reports at the settled height must not move the screen again.
    const calls = fake.scroll.scrollTo.mock.calls.length;
    frame(root, fake.state, 100);
    expect(fake.scroll.scrollTo).toHaveBeenCalledTimes(calls);
  });
});
