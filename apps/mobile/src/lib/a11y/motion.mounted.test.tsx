/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used by the mobile mounted tests. */
import { useState } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BatteryState } from 'expo-battery';
import { ReduceMotion } from 'react-native-reanimated';

import { type MotionPolicy, MotionProvider, useMotionPolicy } from './motion';

const batteryMock = vi.hoisted(() => {
  let level = -1;
  let state = 0;
  const listeners = new Set<() => void>();

  return {
    getLevel: () => level,
    getState: () => state,
    reset: (nextLevel: number, nextState: number) => {
      level = nextLevel;
      state = nextState;
      listeners.clear();
    },
    set: (nextLevel: number, nextState: number) => {
      level = nextLevel;
      state = nextState;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const reanimatedMock = vi.hoisted(() => ({
  systemReducedMotion: false,
  config: vi.fn((_props: { mode: unknown }) => null),
}));

const platformMock = vi.hoisted(() => ({ OS: 'android' }));

vi.mock('expo-battery', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3, NOT_CHARGING: 4 },
    useBatteryLevel: () =>
      useSyncExternalStore(batteryMock.subscribe, batteryMock.getLevel, batteryMock.getLevel),
    useBatteryState: () =>
      useSyncExternalStore(batteryMock.subscribe, batteryMock.getState, batteryMock.getState),
  };
});

vi.mock('react-native-reanimated', () => ({
  ReducedMotionConfig: reanimatedMock.config,
  ReduceMotion: { Always: 'always', Never: 'never', System: 'system' },
  useReducedMotion: () => reanimatedMock.systemReducedMotion,
}));

vi.mock('react-native', () => ({ Platform: platformMock }));

let childMounts = 0;
let policy: MotionPolicy | undefined = undefined;

function PolicyProbe() {
  useState(() => {
    childMounts += 1;
  });
  policy = useMotionPolicy();
  return null;
}

function currentPolicy(): MotionPolicy {
  if (!policy) {
    throw new Error('the motion policy did not render');
  }
  return policy;
}

function currentGlobalMode(): unknown {
  return reanimatedMock.config.mock.calls.at(-1)?.[0].mode;
}

function mount(level: number, state: BatteryState): ReactTestRenderer {
  batteryMock.reset(level, state);
  const renderer: { current?: ReactTestRenderer } = {};
  act(() => {
    renderer.current = TestRenderer.create(
      <MotionProvider>
        <PolicyProbe />
      </MotionProvider>
    );
  });
  if (!renderer.current) {
    throw new Error('the motion provider did not mount');
  }
  return renderer.current;
}

beforeEach(() => {
  childMounts = 0;
  policy = undefined;
  reanimatedMock.systemReducedMotion = false;
  reanimatedMock.config.mockClear();
  platformMock.OS = 'android';
});

describe('MotionProvider battery policy', () => {
  it.each([
    { name: '15% unplugged', level: 0.15, state: BatteryState.UNPLUGGED, reduced: true },
    {
      name: '15% not charging',
      level: 0.15,
      state: BatteryState.NOT_CHARGING,
      reduced: true,
    },
    { name: '20% unplugged', level: 0.2, state: BatteryState.UNPLUGGED, reduced: false },
    { name: '80% unplugged', level: 0.8, state: BatteryState.UNPLUGGED, reduced: false },
    { name: 'charging', level: 0.15, state: BatteryState.CHARGING, reduced: false },
    { name: 'full', level: 0.15, state: BatteryState.FULL, reduced: false },
    { name: 'unknown', level: 0.15, state: BatteryState.UNKNOWN, reduced: false },
    { name: 'unavailable level', level: -1, state: BatteryState.UNPLUGGED, reduced: false },
  ])('selects normal or low battery motion for $name', ({ level, state, reduced }) => {
    const renderer = mount(level, state);

    expect(currentPolicy()).toEqual({ reducedMotion: reduced, scrollAnimated: !reduced });
    expect(currentGlobalMode()).toBe(reduced ? ReduceMotion.Always : ReduceMotion.System);

    renderer.unmount();
  });

  it.each(['android', 'ios'] as const)(
    'enables low battery motion on $os for the same low reading',
    os => {
      platformMock.OS = os;
      const renderer = mount(0.15, BatteryState.NOT_CHARGING);

      expect(currentPolicy()).toEqual({ reducedMotion: true, scrollAnimated: false });
      expect(currentGlobalMode()).toBe(ReduceMotion.Always);

      renderer.unmount();
    }
  );

  it('updates the policy and global mode without remounting the application tree', () => {
    const renderer = mount(0.8, BatteryState.UNPLUGGED);

    expect(currentPolicy().reducedMotion).toBe(false);
    expect(childMounts).toBe(1);

    act(() => {
      batteryMock.set(0.15, BatteryState.UNKNOWN);
    });
    expect(currentPolicy().reducedMotion).toBe(false);
    expect(childMounts).toBe(1);

    act(() => {
      batteryMock.set(0.15, BatteryState.NOT_CHARGING);
    });
    expect(currentPolicy().reducedMotion).toBe(true);
    expect(currentGlobalMode()).toBe(ReduceMotion.Always);
    expect(childMounts).toBe(1);

    act(() => {
      batteryMock.set(0.15, BatteryState.CHARGING);
    });
    expect(currentPolicy().reducedMotion).toBe(false);
    expect(currentGlobalMode()).toBe(ReduceMotion.System);
    expect(childMounts).toBe(1);

    act(() => {
      batteryMock.set(0.8, BatteryState.NOT_CHARGING);
    });
    expect(currentPolicy().reducedMotion).toBe(false);
    expect(currentGlobalMode()).toBe(ReduceMotion.System);
    expect(childMounts).toBe(1);

    renderer.unmount();
  });

  it('combines the system setting with the battery policy', () => {
    reanimatedMock.systemReducedMotion = true;
    const renderer = mount(0.8, BatteryState.UNPLUGGED);

    expect(currentPolicy()).toEqual({ reducedMotion: true, scrollAnimated: false });
    expect(currentGlobalMode()).toBe(ReduceMotion.System);

    renderer.unmount();
  });
});
