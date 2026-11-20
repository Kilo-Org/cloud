// Where the Android in-sheet toast starts: below the sheet's real
// `SheetHeader`, measured from the layout the header reports, and never inside
// the status bar. The first version measured the header against its sibling
// anchor with `measureLayout`, which only measures against an ancestor; on
// device it failed every time and the toast drew at the sheet's top edge — over
// the status bar in the full-height MCP server form, and over the "Discard
// changes?" title at font scale 2.0.

import {
  harness,
  hostsOfType,
  mount,
  raise,
  resetToasterHarness,
  theToaster,
  unmountToasterHarness,
} from '@/components/app-toaster.test-helpers';
import { createElement, type ReactNode } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { SheetHeader } from '@/components/sheet-header';
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

/** The view whose className carries `fragment`: the anchor or the header. */
function hostWithClass(fragment: string): ReactTestInstance {
  const host = hostsOfType('View').find(node =>
    String(node.props.className ?? '').includes(fragment)
  );
  if (!host) {
    throw new Error(`No view with class "${fragment}"`);
  }
  return host;
}

/** Runs a view's real layout handler, as the native layout pass does. */
function layOut(host: ReactTestInstance) {
  act(() => {
    (host.props.onLayout as () => void)();
  });
}

function toastOffset(): number {
  return theToaster().props.offset as number;
}

const onDone = vi.fn<() => void>();

function confirmSheet() {
  return sheet(
    true,
    <>
      <SheetHeader title="Discard changes?" variant="close" topInset="never" onDone={onDone} />
      {createElement('Message')}
      {createElement('DiscardButton')}
    </>
  );
}

/**
 * The window rects the emulator reported for the "Discard changes?" confirm at
 * font scale 2.0, in dp: the sheet's content frame starts at 606.9 and its
 * header ends at 732.2, 125.3 below it.
 */
it('starts the Android in-sheet toast below the real SheetHeader once it lays out', async () => {
  await mount(createElement('Screen', null, confirmSheet()));
  raise('That URL is already saved.');

  harness.frames.anchor = { top: 606.9, bottom: 914.3 };
  harness.frames.header = { top: 606.9, bottom: 732.2 };
  layOut(hostWithClass('absolute inset-0'));
  layOut(hostWithClass('border-b'));

  expect(toastOffset()).toBeGreaterThanOrEqual(732.2 - 606.9);
  // The text stays at a size the space under a short sheet's header can hold.
  expect(theToaster().props.maxFontSizeMultiplier).toBe(1.4);

  // The header grows (a larger font scale): its next layout moves the toast.
  harness.frames.header = { top: 606.9, bottom: 760 };
  layOut(hostWithClass('border-b'));
  expect(toastOffset()).toBeGreaterThanOrEqual(760 - 606.9);
});

/**
 * A full-height sheet's content frame starts at the window top, under the
 * status bar: the toast must never start inside it, header or not.
 */
it('keeps the Android in-sheet toast out of the status bar', async () => {
  harness.insets.top = 24;
  await mount(createElement('Screen', null, sheet(true)));
  raise('That URL is already saved.');

  harness.frames.anchor = { top: 0, bottom: 800 };
  layOut(hostWithClass('absolute inset-0'));

  expect(toastOffset()).toBeGreaterThanOrEqual(24);
});
