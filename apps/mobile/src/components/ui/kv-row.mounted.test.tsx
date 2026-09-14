/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { KvRow } from './kv-row';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));

const longRepository = 'iscekic/kilo-e2e-pr-review-sandbox-86773';

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(props: { value: string; selectable?: boolean }) {
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
});
