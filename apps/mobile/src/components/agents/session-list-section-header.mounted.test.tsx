/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the row without a DOM. */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionListSectionHeader } from './session-list-section-header';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/i18n', () => ({ i18n: { language: 'en', t: (key: string) => key } }));
vi.mock('@/lib/format', () => ({ formatNumber: String }));

const mounted: TestRenderer.ReactTestRenderer[] = [];
function findHost(renderer: TestRenderer.ReactTestRenderer, type: string) {
  return renderer.root.find(node => node.type === type);
}
function mount(hiddenFromA11y: boolean | undefined) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionListSectionHeader, { title: 'TODAY', count: 3, hiddenFromA11y })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mounted.push(renderer);
  return renderer;
}

describe('SessionListSectionHeader accessibility tree membership', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => {
      for (const renderer of mounted) {
        renderer.unmount();
      }
    });
    mounted.length = 0;
  });

  it('stays in the accessibility tree by default', () => {
    const view = findHost(mount(false), 'View');
    expect(view.props.accessibilityElementsHidden).toBe(false);
    expect(view.props.importantForAccessibility).toBe('auto');
  });

  it('removes the in-flow pinned copy from the accessibility tree', () => {
    const view = findHost(mount(true), 'View');
    expect(view.props.accessibilityElementsHidden).toBe(true);
    expect(view.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('defaults to visible when the flag is omitted', () => {
    const view = findHost(mount(undefined), 'View');
    expect(view.props.accessibilityElementsHidden).toBe(false);
    expect(view.props.importantForAccessibility).toBe('auto');
  });
});
