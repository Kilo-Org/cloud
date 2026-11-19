import { type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Section } from './section';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount(element: ReactElement) {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) {
    throw new Error('Missing Section renderer');
  }
  return renderer.root;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

/** The section's content; the header tests only care that it mounts beside the label. */
function Child() {
  return null;
}

describe('Section mounted layout', () => {
  it("forwards the action's testID to the header control", () => {
    const root = mount(
      <Section
        label="Live now"
        actionLabel="See all"
        onActionPress={() => undefined}
        actionTestID="section-see-all"
      >
        <Child />
      </Section>
    );
    const action = root.findByProps({ accessibilityRole: 'button' });

    expect(action.props.testID).toBe('section-see-all');
    expect(action.props.accessibilityLabel).toBe('See all');
  });

  it('renders the header and its content in one stack', () => {
    const root = mount(
      <Section label="Explore">
        <Child />
      </Section>
    );
    const label = root.find(
      node => Object.is(node.type, 'Text') && node.children.includes('Explore')
    );

    expect(label.props.accessibilityRole).toBe('header');
    expect(root.findByType(Child)).toBeDefined();
  });
});
