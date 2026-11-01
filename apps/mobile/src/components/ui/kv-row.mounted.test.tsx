/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { KvRow } from './kv-row';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));

vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));

const longRepository = 'iscekic/kilo-e2e-pr-review-sandbox-86773';

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(props: { value: string; selectable?: boolean; valueDirection?: 'ltr' }) {
  act(() => {
    const element = createElement(KvRow, { label: 'Repository', ...props });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing KvRow renderer');
  }
  return renderer.root;
}

/** The value Text, identified by its rendered string. */
function valueText(root: TestRenderer.ReactTestInstance, value: string) {
  return root.find(node => Object.is(node.type, 'Text') && node.children.includes(value));
}

/** The value's effective style: the shared RTL direction first, the row's own last. */
function valueStyle(node: TestRenderer.ReactTestInstance): Record<string, unknown> {
  const style: unknown = node.props.style;
  if (!Array.isArray(style)) {
    return typeof style === 'object' && style !== null ? { ...style } : {};
  }
  const flattened: Record<string, unknown> = {};
  for (const entry of style as unknown[]) {
    if (typeof entry === 'object' && entry !== null) {
      Object.assign(flattened, entry);
    }
  }
  return flattened;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('KvRow mounted layout', () => {
  // Android's `selectable` routes the value through ReactTextView, which drops
  // the `maxLines` clamp on attach, so a clamped selectable value wrapped past
  // the one-line row height and painted a clipped second line (SPOT-DEFECT:
  // the finding-details Repository row above the Manifest row).
  it('leaves a selectable value unclamped so it wraps inside the row instead of clipping', () => {
    const text = valueText(renderRow({ value: longRepository, selectable: true }), longRepository);
    expect(text.props.selectable).toBe(true);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(text.props.ellipsizeMode).toBeUndefined();
  });

  it('keeps the single-line middle ellipsis on a value that is not selectable', () => {
    const text = valueText(
      renderRow({ value: 'left-pad (npm)', selectable: false }),
      'left-pad (npm)'
    );
    expect(text.props.numberOfLines).toBe(1);
    expect(text.props.ellipsizeMode).toBe('middle');
  });

  // A version range is written left to right, so a right-to-left interface lets
  // the bidi algorithm paint `< 6.13.0` as `6.13.0 >` and invert its meaning.
  it('pins a value that names a version to a left-to-right run', () => {
    const text = valueText(renderRow({ value: '< 6.13.0', valueDirection: 'ltr' }), '< 6.13.0');
    expect(text.props.style).toEqual({ direction: 'ltr', writingDirection: 'ltr' });
  });

  it('keeps that run left-to-right in a right-to-left interface', () => {
    i18nManager.isRTL = true;
    try {
      const text = valueText(renderRow({ value: '< 6.13.0', valueDirection: 'ltr' }), '< 6.13.0');

      expect(valueStyle(text)).toMatchObject({ direction: 'ltr', writingDirection: 'ltr' });
    } finally {
      i18nManager.isRTL = false;
    }
  });

  it('leaves a row without the direction in the interface direction', () => {
    i18nManager.isRTL = true;
    try {
      const text = valueText(renderRow({ value: 'لا يوجد تصحيح متاح' }), 'لا يوجد تصحيح متاح');

      expect(valueStyle(text).writingDirection).toBe('rtl');
    } finally {
      i18nManager.isRTL = false;
    }
  });
});
