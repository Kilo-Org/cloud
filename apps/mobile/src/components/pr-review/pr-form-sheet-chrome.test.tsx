// The form sheet's chrome is the shared `SheetHeader` and `ScreenFooter`: this
// suite pins the wiring only — the reference folded into the title line, Close
// as the way out, the inset the sheet's presentation decides, and a footer that
// leaves the bottom band and the keyboard lift to its host. The primitives'
// own geometry is theirs to test.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { PrFormSheetFooter, PrFormSheetHeader } from './pr-form-sheet-chrome';

const topInsetState = vi.hoisted(() => ({ value: 'android-window-top' as string }));

vi.mock('react-native', () => ({
  Keyboard: { addListener: () => ({ remove: vi.fn() }) },
  Platform: { OS: 'ios' },
  View: 'View',
}));
vi.mock('@/lib/navigation/sheet-header-top-inset', () => ({
  useFormSheetHeaderTopInset: () => topInsetState.value,
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/screen-footer', () => ({ ScreenFooter: 'ScreenFooter' }));

function mountHeader(overrides: { title?: string; eyebrow?: string } = {}) {
  const onBack = vi.fn();
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(PrFormSheetHeader, {
        title: overrides.title ?? 'Merge pull request',
        eyebrow: overrides.eyebrow,
        onBack,
      })
    );
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return { renderer: ref.current, onBack };
}

function headerProps(renderer: TestRenderer.ReactTestRenderer) {
  const [header] = renderer.root.findAllByType('SheetHeader');
  if (!header) {
    throw new Error('SheetHeader not found');
  }
  return header.props as {
    title: string;
    doneLabel?: string;
    topInset?: string;
    onDone: () => void;
  };
}

describe('PrFormSheetHeader', () => {
  beforeEach(() => {
    topInsetState.value = 'android-window-top';
  });

  it('keeps the reference on the title line the shared header draws', () => {
    const { renderer } = mountHeader({ title: 'Merge pull request', eyebrow: 'octocat/hello#1' });

    expect(headerProps(renderer).title).toBe('Merge pull request · octocat/hello#1');
  });

  it('closes with the shared Close label', () => {
    const { renderer, onBack } = mountHeader();

    expect(headerProps(renderer).doneLabel).toBe('Close');
    headerProps(renderer).onDone();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('takes the top inset from the sheet presentation, not a measured frame', () => {
    topInsetState.value = 'bottom-form-sheet';

    const { renderer } = mountHeader();

    expect(headerProps(renderer).topInset).toBe('bottom-form-sheet');
  });
});

describe('PrFormSheetFooter', () => {
  it('leaves the bottom band and the keyboard lift to its host', () => {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(createElement(PrFormSheetFooter, null, 'CTAs'));
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const [footer] = renderer.root.findAllByType('ScreenFooter');
    if (!footer) {
      throw new Error('ScreenFooter not found');
    }
    const props = footer.props as {
      clearance?: string;
      keyboard?: string;
      children?: unknown;
    };
    expect(props.clearance).toBe('host');
    expect(props.keyboard).toBe('host');
    expect(props.children).toBe('CTAs');
  });
});
