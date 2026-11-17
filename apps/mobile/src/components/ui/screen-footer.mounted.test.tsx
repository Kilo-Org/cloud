import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { ScreenFooter } from './screen-footer';

let insets = { top: 0, bottom: 0, left: 0, right: 0 };
let keyboardHeight = 0;
let tabBarBand = 64;

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => insets }));
vi.mock('react-native-keyboard-controller', () => ({
  useKeyboardState: (selector: (state: { height: number }) => unknown) =>
    selector({ height: keyboardHeight }),
}));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => tabBarBand }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

type Props = Parameters<typeof ScreenFooter>[0];

function renderFooter(props: Partial<Props> = {}) {
  act(() => {
    const element = createElement(ScreenFooter, { ...props, children: createElement('View') });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing ScreenFooter renderer');
  }
  const bar = renderer.root.findAll(node => Object.is(node.type, 'View'))[0];
  const gutter = renderer.root.findAll(node => Object.is(node.type, 'View'))[1];
  if (!bar || !gutter) {
    throw new Error('Missing ScreenFooter bar');
  }
  return { bar, gutter };
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  insets = { top: 0, bottom: 0, left: 0, right: 0 };
  keyboardHeight = 0;
  tabBarBand = 64;
});

describe('ScreenFooter', () => {
  it('takes the page gutter, the hairline and the 16pt floor', () => {
    const { bar, gutter } = renderFooter();

    expect(String(bar.props.className).split(' ')).toEqual(
      expect.arrayContaining(['bg-background', 'border-t-[0.5px]', 'border-hair-soft'])
    );
    expect(String(gutter.props.className).split(' ')).toEqual(
      expect.arrayContaining(['px-4', 'pt-3'])
    );
    expect(bar.props.style).toMatchObject({ paddingBottom: 16 });
  });

  it('reserves the home indicator when it is taller than the floor', () => {
    insets = { ...insets, bottom: 34 };

    expect(renderFooter().bar.props.style).toMatchObject({ paddingBottom: 34 });
  });

  it('drops the band the keyboard already covers', () => {
    insets = { ...insets, bottom: 34 };
    keyboardHeight = 300;

    expect(renderFooter().bar.props.style).toMatchObject({ paddingBottom: 0 });
  });

  it('keeps the band a short keyboard leaves', () => {
    insets = { ...insets, bottom: 34 };
    keyboardHeight = 20;

    expect(renderFooter().bar.props.style).toMatchObject({ paddingBottom: 14 });
  });

  it('leaves the keyboard to the host that lifts it', () => {
    insets = { ...insets, bottom: 34 };
    keyboardHeight = 300;

    expect(renderFooter({ keyboard: 'host' }).bar.props.style).toMatchObject({
      paddingBottom: 34,
    });
  });

  it('reserves the tab bar band above the bar', () => {
    insets = { ...insets, bottom: 34 };
    tabBarBand = 83;

    expect(renderFooter({ clearance: 'tab-bar' }).bar.props.style).toMatchObject({
      paddingBottom: 83,
    });
  });

  it('reserves nothing when the host owns the bottom edge', () => {
    insets = { ...insets, bottom: 34 };

    expect(renderFooter({ clearance: 'host' }).bar.props.style).toMatchObject({ paddingBottom: 0 });
  });

  it('paints the background alone without the hairline', () => {
    const { bar } = renderFooter({ edge: 'background' });

    expect(String(bar.props.className).split(' ')).toEqual(['bg-background']);
  });

  it('adds the landscape side inset beside the gutter instead of replacing it', () => {
    insets = { ...insets, left: 40, right: 0 };

    const { bar, gutter } = renderFooter();

    expect(bar.props.style).toMatchObject({ paddingLeft: 40 });
    expect(String(gutter.props.className).split(' ')).toContain('px-4');
  });
});
