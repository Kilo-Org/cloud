// The app-wide gate that owns the touch a native sheet's own window does not
// exist for yet: it must claim at the moment the touch arrives — a layer that
// has to be mounted first is in the touch path after the touch it should have
// claimed — and let everything through while no sheet is up.

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { holdSheetTouch, isSheetTouchHeld } from '@/lib/sheet-touch-guard';
import { renderWithProviders } from '@/test/render-with-providers';
import { act } from '@/test/renderer';

import { SheetTouchGuard } from './sheet-touch-guard';

vi.mock('react-native', () => ({ View: 'View' }));

const noop = (): void => undefined;

const releases: (() => void)[] = [];
const mounted: { unmount: () => void }[] = [];

function hold(): () => void {
  // Long enough that the hold's own bound cannot fire mid-test.
  const release = holdSheetTouch(60_000);
  releases.push(release);
  return release;
}

async function mount() {
  const ui = await renderWithProviders(
    createElement(SheetTouchGuard, null, createElement('View', { testID: 'screen-behind' }))
  );
  mounted.push(ui);
  return ui.renderer;
}

type MountedRenderer = Awaited<ReturnType<typeof mount>>;

function gate(renderer: MountedRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      typeof node.props.onStartShouldSetResponderCapture === 'function'
  )[0];
}

function claims(renderer: MountedRenderer): boolean {
  const node = gate(renderer);
  if (!node) {
    throw new Error('the gate must wrap the app');
  }
  return (node.props.onStartShouldSetResponderCapture as () => boolean)();
}

afterEach(() => {
  act(() => {
    for (const release of releases.splice(0)) {
      release();
    }
  });
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

describe('SheetTouchGuard', () => {
  it('lets a touch through while no sheet is opening', async () => {
    const renderer = await mount();

    expect(isSheetTouchHeld()).toBe(false);
    expect(claims(renderer)).toBe(false);
    // The wrapped tree still renders: the gate is a wrapper, not a replacement.
    expect(renderer.root.findAllByProps({ testID: 'screen-behind' })).toHaveLength(1);
  });

  it('keeps a touch from what the sheet covers while it is opening', async () => {
    const renderer = await mount();

    let release = noop;
    act(() => {
      release = hold();
    });

    // Read when the touch arrives, so the claim is already true for the tap that
    // lands while the sheet's native window is still being created.
    expect(claims(renderer)).toBe(true);
    // And the claim is never handed on to the screen's own controls.
    const node = gate(renderer);
    if (!node) {
      throw new Error('the gate must wrap the app');
    }
    expect((node.props.onResponderTerminationRequest as () => boolean)()).toBe(false);

    act(() => {
      release();
    });

    expect(claims(renderer)).toBe(false);
  });

  it('stays shut until the last hold ends', async () => {
    const renderer = await mount();

    let releaseFirst = noop;
    let releaseSecond = noop;
    act(() => {
      releaseFirst = hold();
      releaseSecond = hold();
    });
    expect(claims(renderer)).toBe(true);

    // A confirm closed inside a sheet that is still up must not let what is
    // behind it start taking touches again.
    act(() => {
      releaseFirst();
    });
    expect(claims(renderer)).toBe(true);

    act(() => {
      releaseSecond();
    });
    expect(claims(renderer)).toBe(false);
  });
});
