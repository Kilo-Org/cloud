/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import {
  LINE_ACTION_BOX_CLASS,
  LINE_ACTION_HIT_SLOP,
  MIN_TAP_TARGET_DP,
  TOUCH_TARGET_DP,
} from '@/lib/a11y/tap-target';

import { AddCreditsButton, AddCreditsRow } from './add-credits-row';

const windowDims = vi.hoisted(() => ({ width: 390, height: 844, fontScale: 1, scale: 2 }));
const platform = vi.hoisted(() => ({ OS: 'android' as string }));

vi.mock('react-native', () => ({
  Platform: platform,
  View: 'View',
  useWindowDimensions: () => windowDims,
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));

const BUTTON = 'Button' as ElementType;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow() {
  act(() => {
    const element = createElement(AddCreditsRow, { url: 'https://example.com/credits' });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing AddCreditsRow renderer');
  }
  return renderer.root;
}

/** The row's only View: the block the button sits in. */
function containerClasses(root: TestRenderer.ReactTestInstance): string[] {
  return String(root.find(node => Object.is(node.type, 'View')).props.className).split(' ');
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  windowDims.width = 390;
  platform.OS = 'android';
});

describe('AddCreditsRow mounted layout', () => {
  it('spans the row in a narrow window', () => {
    windowDims.width = 160;
    const root = renderRow();
    expect(containerClasses(root)).not.toContain('flex-row');
    expect(String(root.findByType(BUTTON).props.className).split(' ')).toContain('w-full');
  });

  it('gives the button the shared state-surface target', () => {
    const root = renderRow();
    expect(String(root.findByType(BUTTON).props.className).split(' ')).toContain('min-h-[48px]');
  });

  it('keeps the shared floor when a caller passes a smaller one', () => {
    act(() => {
      const element = createElement(AddCreditsButton, {
        onPress: () => undefined,
        className: 'min-h-11',
      });
      if (renderer) {
        renderer.update(element);
      } else {
        renderer = TestRenderer.create(element);
      }
    });
    if (!renderer) {
      throw new Error('Missing AddCreditsButton renderer');
    }
    const classes = String(renderer.root.findByType(BUTTON).props.className).split(' ');
    expect(classes).toContain('min-h-[48px]');
    expect(classes).not.toContain('min-h-11');
  });

  it('keeps the button at its natural width at phone widths', () => {
    const root = renderRow();
    expect(containerClasses(root)).toEqual(
      expect.arrayContaining(['flex-row', 'items-center', 'justify-end'])
    );
    expect(String(root.findByType(BUTTON).props.className)).not.toContain('w-full');
  });

  it('renders nothing on iOS', () => {
    platform.OS = 'ios';
    expect(renderRow().findAllByType(BUTTON)).toHaveLength(0);
  });
});

describe('AddCreditsRow inline placement', () => {
  /** The button, whether or not a caller block wraps it. */
  function renderInline() {
    act(() => {
      const element = createElement(AddCreditsRow, {
        url: 'https://example.com/credits',
        inline: true,
      });
      if (renderer) {
        renderer.update(element);
      } else {
        renderer = TestRenderer.create(element);
      }
    });
    if (!renderer) {
      throw new Error('Missing AddCreditsRow renderer');
    }
    return renderer.root;
  }

  it('hands the button over with no block of its own', () => {
    const root = renderInline();
    // `inline` on its own returns the button. The line-action box is the one
    // wrapper an inline call can get, and that suite pins it below.
    expect(root.findAllByType('View')).toHaveLength(0);
    expect(root.findByType(BUTTON)).toBeDefined();
  });

  it('keeps the button at its natural width even in a narrow window', () => {
    windowDims.width = 160;
    const root = renderInline();
    expect(String(root.findByType(BUTTON).props.className ?? '')).not.toContain('w-full');
  });

  it('keeps the App Store gate', () => {
    platform.OS = 'ios';
    expect(renderInline().findAllByType(BUTTON)).toHaveLength(0);
  });
});

describe('AddCreditsRow line action', () => {
  /** The top-up in the caller's own row, on the caller's own text line. */
  function renderLineAction() {
    act(() => {
      const element = createElement(AddCreditsRow, {
        url: 'https://example.com/credits',
        inline: true,
        lineAction: true,
      });
      if (renderer) {
        renderer.update(element);
      } else {
        renderer = TestRenderer.create(element);
      }
    });
    if (!renderer) {
      throw new Error('Missing AddCreditsRow renderer');
    }
    return renderer.root;
  }

  // The box has to be the control's parent, not the control: the caller's row
  // gives a trailing control one text line (17.9dp on the balance row), and a
  // button that carried the box's 28dp frame itself overhung that group by 5dp
  // (SPOT-DEFECT: the hub balance row's "Add credits" clipped finding).
  it('wraps the button in the line-action box', () => {
    const root = renderLineAction();
    const wrappers = root.findAllByType('View');
    expect(wrappers).toHaveLength(1);
    const wrapper = wrappers[0];
    // Every token, so the negative margin that cancels the box's extra height
    // cannot be dropped while the height alone still matches.
    expect(String(wrapper?.props.className).split(' ')).toEqual(
      expect.arrayContaining(LINE_ACTION_BOX_CLASS.split(' '))
    );
    // The box is what the caller lays out; the control fills it.
    expect(wrapper?.findByType(BUTTON)).toBeDefined();
  });

  it('fills the box without carrying a frame or margin of its own', () => {
    const classes = String(renderLineAction().findByType(BUTTON).props.className).split(' ');
    expect(classes).toContain(`min-h-[${MIN_TAP_TARGET_DP}px]`);
    expect(classes).not.toContain('min-h-[48px]');
    // A vertical margin here would move the control inside the box instead of
    // leaving the box to cancel the height.
    expect(classes.filter(token => token.startsWith('-my-'))).toEqual([]);
  });

  it('carries the line-action slop the box needs', () => {
    expect(renderLineAction().findByType(BUTTON).props.hitSlop).toEqual(LINE_ACTION_HIT_SLOP);
  });

  it('reaches the 44pt touch target from the box and its slop', () => {
    expect(
      MIN_TAP_TARGET_DP + LINE_ACTION_HIT_SLOP.top + LINE_ACTION_HIT_SLOP.bottom
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
  });
});
