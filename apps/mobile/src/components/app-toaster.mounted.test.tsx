// On Android a native sheet covers the app's main view tree, so a toast the
// root Toaster draws while a sheet is open stays out of sight until the sheet
// closes (the save-as-to-do failure, the MCP settings failures). There the
// app's one Toaster must render inside the open sheet — the imperative `Sheet`
// and a focused presented route both host it — and hand the toasts back when
// the sheet goes. On iOS the root Toaster's window-level overlay already draws
// above every sheet, so it stays exactly where it is. Where the toast sits
// inside the sheet is `app-toaster.sheet-clearance.mounted.test.tsx`.

import {
  ancestors,
  harness,
  hostAncestors,
  hostsOfType,
  mount,
  raise,
  rerender,
  resetToasterHarness,
  routeScene,
  theToaster,
  toastText,
  unmountToasterHarness,
} from '@/components/app-toaster.test-helpers';
import { createElement, type ReactNode } from 'react';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { Sheet } from '@/components/ui/sheet';

function sheet(visible: boolean, content: ReactNode = createElement('SheetBody')) {
  return (
    <Sheet visible={visible} onClose={() => undefined}>
      {content}
    </Sheet>
  );
}

beforeEach(resetToasterHarness);
afterEach(unmountToasterHarness);

it('draws a toast raised while an Android sheet is open at the top of that sheet', async () => {
  await mount(createElement('Screen', null, sheet(true)));

  raise('Couldn’t load MCP servers');

  expect(ancestors(toastText('Couldn’t load MCP servers'))).toContain('BottomSheet');
  expect(theToaster().props).toMatchObject({
    position: 'top-center',
    fullWindowOverlay: false,
    // The container spans from the toast down, so the toast is inside its
    // parent's rect and stays in the accessibility tree.
    positionerStyle: { bottom: 0 },
  });
  // Touches outside the toast's own box reach the sheet: the nearest view
  // around the Toaster is the anchor over the sheet's frame.
  const [anchor] = hostAncestors(theToaster());
  expect(anchor?.props.pointerEvents).toBe('box-none');
});

it('hands the toasts back to the app tree once the sheet starts to close', async () => {
  await mount(createElement('Screen', null, sheet(true)));
  raise('Saved');
  expect(ancestors(toastText('Saved'))).toContain('BottomSheet');

  // The sheet stays mounted until the native dismissal reports; the toast must
  // not leave with it.
  rerender(createElement('Screen', null, sheet(false)));

  expect(hostsOfType('BottomSheet')).toHaveLength(1);
  expect(ancestors(toastText('Saved'))).not.toContain('BottomSheet');
  expect(theToaster().props.position).toBe('bottom-center');
});

it('draws in the top sheet when a sheet opens over another', async () => {
  await mount(createElement('Screen', null, sheet(true, sheet(true, createElement('Inner')))));

  raise('That URL is already saved.');

  const inner = ancestors(toastText('That URL is already saved.'));
  expect(inner.filter(type => type === 'BottomSheet')).toHaveLength(2);
});

it.each(['formSheet', 'modal'])(
  'draws a toast raised from a focused Android %s route inside its scene',
  async presentation => {
    const focused = { current: true };
    const listeners = new Map<string, () => void>();
    await mount(routeScene(presentation, focused, listeners));

    raise('Couldn’t load that language');

    expect(ancestors(toastText('Couldn’t load that language'))).toContain('Scene');

    // A blurred scene — covered or dismissing — hands the toasts back.
    act(() => {
      focused.current = false;
      listeners.get('blur')?.();
    });
    expect(ancestors(toastText('Couldn’t load that language'))).not.toContain('Scene');
  }
);

it('keeps the toasts in the app tree for a card screen', async () => {
  await mount(routeScene('card', { current: true }, new Map()));

  raise('Link copied');

  expect(ancestors(toastText('Link copied'))).not.toContain('Scene');
});

it('keeps the root Toaster on iOS while sheets and route sheets are open', async () => {
  harness.platform.OS = 'ios';
  await mount(
    createElement(
      'Screen',
      null,
      sheet(true, sheet(true)),
      routeScene('formSheet', { current: true }, new Map())
    )
  );

  raise('Couldn’t load MCP servers');

  const placement = ancestors(toastText('Couldn’t load MCP servers'));
  expect(placement).not.toContain('BottomSheet');
  expect(placement).not.toContain('Scene');
  // Main's root Toaster, unchanged: bottom, window-level overlay, the
  // accessibility anchor, sonner's own padding and font scaling.
  expect(theToaster().props).toMatchObject({
    position: 'bottom-center',
    fullWindowOverlay: true,
    positionerStyle: { top: 0 },
  });
  expect(theToaster().props.maxFontSizeMultiplier).toBeUndefined();
  const toastOptions = theToaster().props.toastOptions as { style: { paddingVertical?: number } };
  expect(toastOptions.style.paddingVertical).toBeUndefined();
});
