import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  mount,
  resetUnlockMocks,
  unlockRoot,
  unmountUnlock,
} from '@/components/app-unlock-screen.test-helpers';
import { holdModalSurface, isModalSurfacePresented } from '@/lib/modal-surface-veil';

/**
 * An in-tree modal surface — a `DialogCard`, the session preview overlay —
 * renders into the app-root `PortalHost`, inside the app's own window, so the
 * screen it covers sits in the same accessibility tree. Android ignores the
 * card's `accessibilityViewIsModal`, so the root itself has to take the covered
 * screen out: measured on the emulator with `uiautomator dump --compressed`, an
 * open rename card left the whole organization hub and its controls listed
 * ahead of the dialog's own `Cancel`/`Save` (40 named nodes).
 *
 * These tests pin the root's half of that contract: while a surface is open the
 * navigator and the app chrome lose the accessibility tree and touch, and the
 * `PortalHost` — which holds the surface itself — stays outside the hidden
 * view.
 */
beforeEach(() => {
  resetUnlockMocks();
});

afterEach(async () => {
  await unmountUnlock();
  expect(isModalSurfacePresented()).toBe(false);
});

/** The view that wraps the navigator, the app chrome and the offline banner. */
function coveredContent(): ReactTestInstance {
  const portalHost = unlockRoot().findByType('PortalHost' as never);
  const holder = portalHost.parent;
  if (!holder) {
    throw new Error('PortalHost has no parent');
  }
  const [covered] = holder.children;
  if (typeof covered === 'string' || covered === undefined) {
    throw new Error('the covered view is not the first child of the touch guard');
  }
  return covered;
}

it('leaves the navigator exposed and tappable while no surface is open', async () => {
  await mount();

  expect(coveredContent().props).toMatchObject({
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
    pointerEvents: 'auto',
  });
});

it('takes the covered screen out of the accessibility tree while a surface is open', async () => {
  await mount();

  let release = (): void => undefined;
  act(() => {
    release = holdModalSurface();
  });

  expect(coveredContent().props).toMatchObject({
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
    pointerEvents: 'none',
  });

  act(() => {
    release();
  });

  expect(coveredContent().props).toMatchObject({
    accessibilityElementsHidden: false,
    importantForAccessibility: 'auto',
    pointerEvents: 'auto',
  });
});

/**
 * The surface itself must stay reachable: it renders into the `PortalHost`, so
 * the host is the hidden view's sibling, never its descendant. A refactor that
 * wraps both together would hide the open dialog from the same screen reader.
 */
it('keeps the portal host that renders the surface outside the hidden view', async () => {
  await mount();

  let release = (): void => undefined;
  act(() => {
    release = holdModalSurface();
  });

  const covered = coveredContent();

  expect(covered.findAllByType('PortalHost' as never)).toHaveLength(0);
  expect(
    unlockRoot()
      .findByType('PortalHost' as never)
      .parent?.children.some(child => child === covered)
  ).toBe(true);

  act(() => {
    release();
  });
});

/**
 * Two surfaces stack in the app (a preview overlay opens a rename card): the
 * first close must not reveal the screen while the second is still up, and the
 * covered presentation must end only with the last one.
 */
it('stays covered until the last open surface closes', async () => {
  await mount();

  let releaseCard = (): void => undefined;
  let releasePreview = (): void => undefined;
  act(() => {
    releasePreview = holdModalSurface();
    releaseCard = holdModalSurface();
  });

  act(() => {
    releaseCard();
  });

  expect(coveredContent().props.importantForAccessibility).toBe('no-hide-descendants');

  act(() => {
    releasePreview();
  });

  expect(coveredContent().props.importantForAccessibility).toBe('auto');
});
