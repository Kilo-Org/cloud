/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/ui/accessible-status.mounted.test.tsx) */
import { createElement, useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { type MotionPolicy, useMotionPolicy } from './motion';

// Centralized reduced-motion policy (P3-C-05, D15). Reduce motion on maps to
// immediate imperative scrolls; off keeps them animated.

const reduceMotionMock = vi.hoisted(() => ({ current: true }));

vi.mock('react-native-reanimated', () => ({
  useReducedMotion: () => reduceMotionMock.current,
}));

const policyHolder: { current?: MotionPolicy } = {};

function PolicyHarness() {
  const policy = useMotionPolicy();
  useEffect(() => {
    policyHolder.current = policy;
  }, [policy]);
  return null;
}

async function mountPolicy(): Promise<{ policy: MotionPolicy; unmount: () => void }> {
  const holder: { current?: TestRenderer.ReactTestRenderer } = {};
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(createElement(PolicyHarness));
  });
  const renderer = holder.current;
  if (renderer === undefined) {
    throw new Error('renderer was not created');
  }
  const policy = policyHolder.current;
  if (policy === undefined) {
    throw new Error('policy was not captured');
  }
  return {
    policy,
    unmount: () => {
      renderer.unmount();
    },
  };
}

describe('useMotionPolicy', () => {
  it('maps reduce motion on to immediate scrolls', async () => {
    reduceMotionMock.current = true;
    const { policy, unmount } = await mountPolicy();

    expect(policy).toEqual({ reduceMotion: true, scrollAnimated: false });
    unmount();
  });

  it('keeps animated scrolls when reduce motion is off', async () => {
    reduceMotionMock.current = false;
    const { policy, unmount } = await mountPolicy();

    expect(policy).toEqual({ reduceMotion: false, scrollAnimated: true });
    unmount();
  });
});
