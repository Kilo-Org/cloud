// The detector renders its options body only when the detector is not off and
// the caller supplied a body. A detector without options must not add a second
// child wrapper: that wrapper is an empty block that leaves a blank gap below
// the choice control. So a bodiless detector paints its header block and the
// choice control, and an off detector paints none of its options even when a
// caller passes them.

import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { DetectorCard } from './guardrails-detector-editor';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let renderer: ReactTestRenderer | undefined = undefined;

/** The detector's own block, whose children are what it paints in order. */
function mount(choice: 'off' | 'log' | 'block', children?: ReactNode): ReactTestInstance {
  act(() => {
    renderer = TestRenderer.create(
      createElement(
        DetectorCard,
        {
          label: 'PII',
          description: 'Personal data',
          choice,
          onChoiceChange: () => undefined,
          disabled: false,
        },
        children
      )
    );
  });
  if (!renderer) {
    throw new Error('Missing detector renderer');
  }
  const block = renderer.root.children[0] as ReactTestInstance | undefined;
  if (!block) {
    throw new Error('Missing detector block');
  }
  return block;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('DetectorCard options body', () => {
  it('draws no options block when the caller passes none', () => {
    const painted = mount('log').children.map(child => String((child as ReactTestInstance).type));

    expect(painted).toEqual(['View', 'SegmentedControl']);
  });

  it('wraps a supplied options body in one block of its own', () => {
    const painted = mount('log', createElement('Child', { key: 'child' })).children;
    const body = painted[2] as ReactTestInstance | undefined;

    expect(painted).toHaveLength(3);
    if (!body) {
      throw new Error('Missing options wrapper');
    }
    expect(body.type).toBe('View');
    expect(body.children).toHaveLength(1);
  });

  it('draws no options block while the detector is off', () => {
    const painted = mount('off', createElement('Child', { key: 'child' })).children.map(child =>
      String((child as ReactTestInstance).type)
    );

    expect(painted).toEqual(['View', 'SegmentedControl']);
  });

  // The output section passes one conditional child per detector, so a detector
  // with no options of its own receives an array of `null`s rather than nothing.
  it('draws no options block for a list of conditional children that all skip', () => {
    const painted = mount('log', [null, false, null]).children.map(child =>
      String((child as ReactTestInstance).type)
    );

    expect(painted).toEqual(['View', 'SegmentedControl']);
  });
});
