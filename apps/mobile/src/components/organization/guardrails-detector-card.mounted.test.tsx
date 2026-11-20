// The detector card draws its options body only when the detector is not off
// and the caller supplied a body. A card without options must not add a second
// child wrapper: that wrapper is an empty block that leaves a blank gap below
// the choice control. So a bodiless card renders exactly one View, and an off
// detector renders none of its options even when a caller passes them.

import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { DetectorCard } from './guardrails-detector-editor';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let renderer: ReactTestRenderer | undefined = undefined;

function mount(choice: 'off' | 'log' | 'block', children?: ReactElement): ReactTestInstance {
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
    throw new Error('Missing card renderer');
  }
  return renderer.root;
}

function views(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAllByType('View' as never);
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('DetectorCard options body', () => {
  it('renders only the header View when the caller passes no options', () => {
    expect(views(mount('log'))).toHaveLength(1);
  });

  it('wraps a supplied options body in its own View', () => {
    const card = mount('log', createElement('Child', { key: 'child' }));
    const found = views(card);

    expect(found).toHaveLength(2);
    const body = found[1];
    if (!body) {
      throw new Error('Missing options wrapper');
    }
    expect(body.children).toHaveLength(1);
  });

  it('renders nothing but the header View while the detector is off', () => {
    expect(views(mount('off', createElement('Child', { key: 'child' })))).toHaveLength(1);
  });
});
