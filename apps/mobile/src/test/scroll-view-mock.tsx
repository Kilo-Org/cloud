import { createElement, forwardRef, type Ref, useImperativeHandle } from 'react';
import { vi } from 'vitest';

/**
 * Records the body-scroll calls a mounted screen makes through its `ScrollView`
 * ref, so a suite can prove the scroll happened instead of trusting it.
 */
export const scrollTo = vi.fn();

/**
 * Stand-in for React Native's `ScrollView` in mounted suites: it renders the
 * host `ScrollView` element (which the layout assertions walk) and exposes the
 * frame API screens call on the ref.
 */
export const MockScrollView = forwardRef(function MockScrollView(props: object, ref: Ref<unknown>) {
  useImperativeHandle(ref, () => ({ scrollTo }));
  return createElement('ScrollView', props);
});
