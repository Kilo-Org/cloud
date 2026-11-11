import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clampLiftPad,
  type KeyboardLiftFrame,
  OwnedKeyboardLift,
  useKeyboardLiftPad,
} from './owned-keyboard-lift';
import { MIN_BODY_VIEWPORT } from '@/lib/body-viewport';

type LiftRenderer = TestRenderer.ReactTestRenderer;

/** The host props this suite reads off the lift's own frame view. */
type FrameProps = {
  style?: { paddingBottom?: unknown };
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
};

/** The window the mounted lift lays its frame out in, as a rotation changes it. */
const windowState = { height: 874 };
/** The band the screen's own input raised, as the keyboard raises and drops it. */
const screenState = { occlusion: 0 };
/** The hook value the harness last read, to compare with the written pad. */
const seen: { value?: KeyboardLiftFrame } = {};

vi.mock('react-native', () => ({
  View: 'View',
  useWindowDimensions: () => ({ width: 402, height: windowState.height, scale: 3, fontScale: 1 }),
}));

/**
 * Runs the hook and its frame the way a screen does: the screen reads the pad
 * in the same render that writes it.
 */
function Harness() {
  const value = useKeyboardLiftPad(screenState.occlusion);
  seen.value = value;
  return (
    <OwnedKeyboardLift pad={value.pad} onLayout={value.handleLayout}>
      <HarnessBody />
    </OwnedKeyboardLift>
  );
}

function HarnessBody() {
  return null;
}

function mountLift(): LiftRenderer {
  const mounted: { current?: LiftRenderer } = {};
  act(() => {
    mounted.current = TestRenderer.create(createElement(Harness));
  });
  if (!mounted.current) {
    throw new Error('the lift did not mount');
  }
  return mounted.current;
}

/** Replace the window, as a rotation does, and run the render it produces. */
function rotateWindow(renderer: LiftRenderer, height: number) {
  windowState.height = height;
  act(() => {
    renderer.update(createElement(Harness));
  });
}

/** Report a laid-out frame height, the way the native layout pass does. */
function layout(renderer: LiftRenderer, height: number) {
  // The lift's only host view is the body frame it pads.
  const onLayout = renderer.root.findByType('View').props.onLayout as FrameProps['onLayout'];
  if (!onLayout) {
    throw new TypeError('The keyboard lift renders no layout handler');
  }
  act(() => {
    onLayout({ nativeEvent: { layout: { height } } });
  });
}

/** The pad the lift writes on the body frame, in device-independent points. */
function liftPad(renderer: LiftRenderer): number {
  const pad = (renderer.root.findByType('View').props.style as FrameProps['style'])?.paddingBottom;
  if (typeof pad !== 'number') {
    throw new TypeError('The keyboard lift wrote a non-numeric paddingBottom');
  }
  return pad;
}

describe('clampLiftPad', () => {
  it('reserves the whole keyboard band while the body has the room', () => {
    expect(clampLiftPad(336, { height: 758, windowHeight: 874 }, 874)).toBe(336);
  });

  it('keeps the minimum viewport when the band is taller than the body its window leaves', () => {
    expect(clampLiftPad(336, { height: 253, windowHeight: 402 }, 402)).toBe(
      253 - MIN_BODY_VIEWPORT
    );
    expect(clampLiftPad(336, { height: 120, windowHeight: 402 }, 402)).toBe(
      120 - MIN_BODY_VIEWPORT
    );
  });

  it('releases the whole band when even the viewport does not fit', () => {
    expect(clampLiftPad(336, { height: MIN_BODY_VIEWPORT, windowHeight: 402 }, 402)).toBe(0);
    expect(clampLiftPad(336, { height: 40, windowHeight: 402 }, 402)).toBe(0);
  });

  it('pads nothing while the keyboard is closed', () => {
    expect(clampLiftPad(0, { height: 253, windowHeight: 874 }, 874)).toBe(0);
    expect(clampLiftPad(0, null, 874)).toBe(0);
  });

  it('reserves the whole band before the frame is measured', () => {
    expect(clampLiftPad(336, null, 874)).toBe(336);
  });

  it('releases a measurement taken in another window', () => {
    // A rotation render still carries the portrait frame: 758 points of room and
    // a 336-point band, in a window that now has 402 points of height. Pad 336
    // into the landscape frame and the list draws nothing at all.
    expect(clampLiftPad(336, { height: 758, windowHeight: 874 }, 402)).toBe(0);
  });
});

describe('useKeyboardLiftPad', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    windowState.height = 874;
    screenState.occlusion = 0;
  });

  it('writes the measured band for a body that has the room', () => {
    screenState.occlusion = 336;
    const renderer = mountLift();
    layout(renderer, 758);

    expect(liftPad(renderer)).toBe(336);
  });

  it('keeps the body rendered when a rotation leaves less room than the band', () => {
    screenState.occlusion = 336;
    const renderer = mountLift();
    layout(renderer, 758);
    expect(liftPad(renderer)).toBe(336);

    layout(renderer, 253);

    expect(liftPad(renderer)).toBe(253 - MIN_BODY_VIEWPORT);
  });

  it('releases the stale portrait frame for the render a rotation produces', () => {
    screenState.occlusion = 336;
    const renderer = mountLift();
    layout(renderer, 758);
    expect(liftPad(renderer)).toBe(336);

    // The rotation render runs before the landscape layout pass reports the new
    // frame, so the pad must not reuse the portrait measurement.
    rotateWindow(renderer, 402);
    expect(liftPad(renderer)).toBe(0);

    layout(renderer, 298);
    expect(liftPad(renderer)).toBe(298 - MIN_BODY_VIEWPORT);
  });

  it('gives the pad back when the keyboard closes', () => {
    const renderer = mountLift();
    layout(renderer, 253);

    expect(liftPad(renderer)).toBe(0);
  });

  it('hands the pad to the screen that reserves the same band in this render', () => {
    // The Agents list reads the pad for its floating button band. A pad that
    // reached it through a later effect would reserve the previous frame's band.
    screenState.occlusion = 320;
    const renderer = mountLift();
    expect(seen.value?.pad).toBe(320);

    layout(renderer, 253);

    expect(seen.value?.pad).toBe(253 - MIN_BODY_VIEWPORT);
    expect(liftPad(renderer)).toBe(seen.value?.pad);
  });
});
