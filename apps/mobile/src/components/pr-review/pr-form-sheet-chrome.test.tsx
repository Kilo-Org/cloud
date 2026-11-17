// The form sheet's chrome is the shared `SheetHeader` and `ScreenFooter`: this
// suite pins the wiring only — the reference on the header's own caption line,
// Close as the way out, the inset the sheet's presentation decides, and a footer
// whose bottom band the primitive owns while the keyboard lift stays with the
// host. The primitives' own geometry is theirs to test.

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
  const onBack = vi.fn<() => void>();
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
    eyebrow?: string;
    variant?: string;
    doneLabel?: string;
    topInset?: string;
    onDone: () => void;
  };
}

describe('PrFormSheetHeader', () => {
  beforeEach(() => {
    topInsetState.value = 'android-window-top';
  });

  it('keeps the reference on the header’s own caption line', () => {
    const { renderer } = mountHeader({ title: 'Merge pull request', eyebrow: 'octocat/hello#1' });

    const props = headerProps(renderer);
    expect(props.title).toBe('Merge pull request');
    expect(props.eyebrow).toBe('octocat/hello#1');
  });

  it('closes with the shared close variant and Close label', () => {
    const { renderer, onBack } = mountHeader();

    const props = headerProps(renderer);
    expect(props.variant).toBe('close');
    expect(props.doneLabel).toBe('Close');
    props.onDone();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('takes the top inset from the sheet presentation, not a measured frame', () => {
    topInsetState.value = 'bottom-form-sheet';

    const { renderer } = mountHeader();

    expect(headerProps(renderer).topInset).toBe('bottom-form-sheet');
  });
});

describe('PrFormSheetFooter', () => {
  it('keeps its bottom clearance from the primitive and the keyboard lift at the host', () => {
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
    // The CTAs sit on a sheet that owns its own window; the primitive's
    // safe-area band is what keeps them off the home indicator, and the scroll
    // view's keyboard inset is the only lift (a second one would push them
    // under the keyboard).
    expect(props.clearance).toBe('safe-area');
    expect(props.keyboard).toBe('host');
    expect(props.children).toBe('CTAs');
  });
});
