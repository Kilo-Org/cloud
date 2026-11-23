import { createElement, type ReactElement, type RefObject } from 'react';
import { type ScrollViewInstance } from 'react-native';

import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

/** The mocked scroller's committed geometry and offset. */
export type ScrollState = {
  /** The top edge a row's measurement reports, in content coordinates. */
  top: number;
  contentHeight: number;
  frameHeight: number;
  offset: number;
};

/** Restore the scroller to the state each case starts from. */
export function resetScroll(state: ScrollState) {
  state.top = 40;
  state.contentHeight = 0;
  state.frameHeight = 0;
  state.offset = 0;
}

/** Mount, update and unmount the one renderer a suite drives. */
export function createHarness() {
  let renderer: ReactTestRenderer | undefined = undefined;
  const mount = (element: ReactElement) => {
    act(() => {
      renderer = TestRenderer.create(element);
    });
    if (renderer === undefined) {
      throw new Error('Missing renderer');
    }
    return renderer.root;
  };
  const update = (element: ReactElement) => {
    if (renderer === undefined) {
      throw new Error('Missing renderer');
    }
    act(() => {
      renderer?.update(element);
    });
  };
  const unmount = () => {
    act(() => renderer?.unmount());
    renderer = undefined;
  };
  return { mount, update, unmount };
}

/** A ref holding a test double: the reveal path reads only its three members. */
export function scrollTarget(instance: unknown): RefObject<ScrollViewInstance | null> {
  return { current: instance as ScrollViewInstance };
}

export function row(testID = 'row') {
  return createElement('Row', { testID });
}

export function overlays(root: ReactTestInstance) {
  return root.findAll(
    node => Object.is(node.type, 'View') && String(node.props.className).includes('border-primary')
  );
}

/** The wrapper the active row draws around itself. */
export function wrapper(root: ReactTestInstance) {
  return root.findAll(
    node => Object.is(node.type, 'View') && node.props.className === 'relative'
  )[0];
}

/** Fire the layout pass that registers the active row for its reveal. */
export function layout(node: ReactTestInstance | undefined) {
  act(() => {
    (node?.props.onLayout as (() => void) | undefined)?.();
  });
}

/** The scroller's committed content size, as its post-layout report. */
export function contentSize(root: ReactTestInstance, state: ScrollState, height: number) {
  state.contentHeight = height;
  const handler = root.findByType('TabScroll').props.onContentSizeChange as
    | ((width: number, height: number) => void)
    | undefined;
  act(() => {
    handler?.(0, height);
  });
}

/** The scroller's committed viewport frame. */
export function frame(root: ReactTestInstance, state: ScrollState, height: number) {
  state.frameHeight = height;
  const handler = root.findByType('TabScroll').props.onLayout as
    | ((event: { nativeEvent: { layout: { height: number } } }) => void)
    | undefined;
  act(() => {
    handler?.({ nativeEvent: { layout: { height } } });
  });
}
