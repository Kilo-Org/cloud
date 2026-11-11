import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clampLiftPad,
  OwnedKeyboardLift,
  type OwnedKeyboardLiftProps,
} from './owned-keyboard-lift';
import { MIN_BODY_VIEWPORT } from '@/lib/body-viewport';

vi.mock('react-native', () => ({
  View: 'View',
}));

type LiftRenderer = TestRenderer.ReactTestRenderer;

/** The host props this suite reads off the lift's own frame view. */
type FrameProps = {
  style?: { paddingBottom?: unknown };
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
};

function liftProps(occlusion: number, onApplied?: (applied: number) => void) {
  const props: OwnedKeyboardLiftProps = {
    occlusion,
    onApplied,
    children: createElement('Body'),
  };
  return props;
}

function renderLift(occlusion: number, onApplied?: (applied: number) => void): LiftRenderer {
  const mounted: { current: LiftRenderer | undefined } = { current: undefined };
  act(() => {
    mounted.current = TestRenderer.create(
      createElement(OwnedKeyboardLift, liftProps(occlusion, onApplied), null)
    );
  });
  if (!mounted.current) {
    throw new Error('the lift did not mount');
  }
  return mounted.current;
}

function frameProps(renderer: LiftRenderer): FrameProps {
  // The lift's only host view is the body frame it pads.
  return renderer.root.findByType('View').props;
}

/** The pad the lift writes on the body frame, in device-independent points. */
function liftPad(renderer: LiftRenderer): number {
  const pad = frameProps(renderer).style?.paddingBottom;
  if (typeof pad !== 'number') {
    throw new TypeError('The keyboard lift wrote a non-numeric paddingBottom');
  }
  return pad;
}

/** Report a laid-out frame height, the way the native layout pass does. */
function layout(renderer: LiftRenderer, height: number) {
  const onLayout = frameProps(renderer).onLayout;
  if (!onLayout) {
    throw new TypeError('The keyboard lift renders no layout handler');
  }
  act(() => {
    onLayout({ nativeEvent: { layout: { height } } });
  });
}

describe('clampLiftPad', () => {
  it('reserves the whole keyboard band while the body has the room', () => {
    expect(clampLiftPad(336, 758)).toBe(336);
  });

  it('keeps the minimum viewport when the band is taller than the body its window leaves', () => {
    // An iPhone rotated to landscape: the recorded keyboard height belongs to
    // the portrait window, and the landscape frame is shorter than the band.
    expect(clampLiftPad(336, 253)).toBe(253 - MIN_BODY_VIEWPORT);
    expect(clampLiftPad(336, 120)).toBe(120 - MIN_BODY_VIEWPORT);
  });

  it('releases the whole band when even the viewport does not fit', () => {
    expect(clampLiftPad(336, MIN_BODY_VIEWPORT)).toBe(0);
    expect(clampLiftPad(336, 40)).toBe(0);
  });

  it('pads nothing while the keyboard is closed', () => {
    expect(clampLiftPad(0, 253)).toBe(0);
    expect(clampLiftPad(0, null)).toBe(0);
  });

  it('reserves the whole band before the frame is measured', () => {
    expect(clampLiftPad(336, null)).toBe(336);
  });
});

describe('OwnedKeyboardLift', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('writes the measured band for a body that has the room', () => {
    const renderer = renderLift(336);
    layout(renderer, 758);

    expect(liftPad(renderer)).toBe(336);
  });

  it('keeps the body rendered when a rotation leaves less room than the band', () => {
    const renderer = renderLift(336);
    layout(renderer, 758);
    expect(liftPad(renderer)).toBe(336);

    layout(renderer, 253);

    expect(liftPad(renderer)).toBe(253 - MIN_BODY_VIEWPORT);
  });

  it('gives the pad back when the keyboard closes', () => {
    const renderer = renderLift(336);
    layout(renderer, 253);

    act(() => {
      renderer.update(createElement(OwnedKeyboardLift, liftProps(0), null));
    });

    expect(liftPad(renderer)).toBe(0);
  });

  it('reports the pad it wrote, so a shared band can subtract the reserved part', () => {
    const applied: number[] = [];
    const renderer = renderLift(336, pad => {
      applied.push(pad);
    });
    layout(renderer, 253);

    expect(applied.at(-1)).toBe(253 - MIN_BODY_VIEWPORT);
  });
});
