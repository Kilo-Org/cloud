/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { AddCreditsRow } from './add-credits-row';

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
