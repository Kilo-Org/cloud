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
// The chevron is a theme-coloured glyph, so it mounts as its own type here: the
// assertions read its presence, not its paint.
vi.mock('@/components/ui/row-chevron', () => ({ RowChevron: 'RowChevron' }));

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

  it('ends the action in the shared chevron only when asked to', () => {
    const withChevron = mount(
      <Section label="Usage" actionLabel="Usage" actionChevron onActionPress={() => undefined}>
        <Child />
      </Section>
    );
    const action = withChevron.findByProps({ accessibilityRole: 'button' });

    // The chevron sits inside the button, after the copy, and adds no name of
    // its own: the button's label is the action's alone.
    expect(action.findAllByType('RowChevron' as never)).toHaveLength(1);
    expect(action.props.accessibilityLabel).toBe('Usage');
    expect(String(action.props.className)).toContain('gap-1');

    act(() => renderer?.unmount());
    const textOnly = mount(
      <Section label="Usage" actionLabel="Usage" onActionPress={() => undefined}>
        <Child />
      </Section>
    );
    const plainAction = textOnly.findByProps({ accessibilityRole: 'button' });

    expect(plainAction.findAllByType('RowChevron' as never)).toHaveLength(0);
    // A text-only action keeps the box it had, gap included.
    expect(String(plainAction.props.className)).not.toContain('gap-1');
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
