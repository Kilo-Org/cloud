import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Text: 'Text',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
function mount(element: ReactElement) {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) {
    throw new Error('Missing Text renderer');
  }
  return renderer.root;
}

function tokens(className: unknown): string[] {
  return (className as string).split(' ');
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18nManager.isRTL = false;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('Text Latin label treatment', () => {
  it('drops the family and the tracking for an Arabic eyebrow in RTL', () => {
    i18nManager.isRTL = true;
    const root = mount(createElement(Text, { variant: 'eyebrow' }, 'الجلسات الجارية الآن'));
    const node = root.find(instance => Object.is(instance.type, 'Text'));
    const classes = tokens(node.props.className);

    expect(classes.some(token => token.startsWith('font-mono'))).toBe(false);
    expect(classes.some(token => token.startsWith('tracking'))).toBe(false);
    expect(classes).toEqual(expect.arrayContaining(['text-[10px]', 'text-muted-foreground']));
    expect(node.props.style).toContainEqual({ writingDirection: 'rtl' });
  });

  it('keeps the tracked capitals for Latin copy in RTL', () => {
    i18nManager.isRTL = true;
    const root = mount(createElement(Text, { variant: 'eyebrow' }, 'LIVE NOW'));
    const node = root.find(instance => Object.is(instance.type, 'Text'));
    const classes = tokens(node.props.className);

    expect(classes).toEqual(
      expect.arrayContaining(['font-mono-medium', 'uppercase', 'tracking-[1.5px]'])
    );
  });

  it('keeps the treatment for Arabic copy in an LTR interface', () => {
    i18nManager.isRTL = false;
    const root = mount(createElement(Text, { variant: 'eyebrow' }, 'الجلسات الجارية الآن'));
    const node = root.find(instance => Object.is(instance.type, 'Text'));
    const classes = tokens(node.props.className);

    expect(classes).toEqual(
      expect.arrayContaining(['font-mono-medium', 'uppercase', 'tracking-[1.5px]'])
    );
  });

  it('drops the mono family for an Arabic mono variant in RTL', () => {
    i18nManager.isRTL = true;
    const root = mount(createElement(Text, { variant: 'mono' }, 'الجلسات الجارية الآن'));
    const node = root.find(instance => Object.is(instance.type, 'Text'));

    expect(tokens(node.props.className).some(token => token.startsWith('font-mono'))).toBe(false);
  });

  it('keeps the mono family for a session id in RTL', () => {
    i18nManager.isRTL = true;
    const root = mount(createElement(Text, { variant: 'mono' }, 'ses_9f2c1a7b'));
    const node = root.find(instance => Object.is(instance.type, 'Text'));

    expect(tokens(node.props.className)).toContain('font-mono-medium');
  });
});
