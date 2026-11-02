import { type ElementType } from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import {
  AdaptiveHomeCardFrame,
  CardControl,
  useReservedHomeCardLayer,
} from './adaptive-home-card-frame';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View', Text: 'Text' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(' '),
}));

function LayerFlag({ name }: Readonly<{ name: string }>) {
  const reserved = useReservedHomeCardLayer();
  return <View nativeID={name} testID={reserved ? 'reserved' : 'drawn'} />;
}

function ControlProbe() {
  return (
    <CardControl
      accessibilityRole="button"
      accessibilityLabel="control"
      className="min-h-[44px] active:opacity-70"
      onPress={() => undefined}
    >
      <View />
    </CardControl>
  );
}

function renderControl(showBriefing: boolean): ReactTestRenderer {
  const ref: { current: ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      <AdaptiveHomeCardFrame live={<ControlProbe />} showBriefing={showBriefing} />
    );
  });
  if (!ref.current) {
    throw new Error('CardControl did not mount');
  }
  return ref.current;
}

function render(showBriefing: boolean): ReactTestRenderer {
  const ref: { current: ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      <AdaptiveHomeCardFrame
        live={<LayerFlag name="live" />}
        briefing={<LayerFlag name="briefing" />}
        showBriefing={showBriefing}
      />
    );
  });
  if (!ref.current) {
    throw new Error('AdaptiveHomeCardFrame did not mount');
  }
  return ref.current;
}

/** The two card layers in tree order, then the spacer that reserves the minimum frame. */
function layers(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType('View' as ElementType)
    .filter(node => node.props.pointerEvents !== undefined);
}

describe('CardControl', () => {
  it('renders a press target with the layout classes and the press feedback when drawn', () => {
    const [control] = renderControl(false).root.findAllByType('Pressable' as ElementType);
    expect(String(control?.props.className)).toContain('min-h-[44px]');
    expect(String(control?.props.className)).toContain('active:opacity-70');
    expect(typeof control?.props.onPress).toBe('function');
  });

  it('keeps only the layout classes when the layer only reserves height', () => {
    const renderer = renderControl(true);
    expect(renderer.root.findAllByType('Pressable' as ElementType)).toHaveLength(0);
    const control = renderer.root
      .findAllByType('View' as ElementType)
      .find(node => String(node.props.className ?? '').includes('min-h-[44px]'));
    expect(String(control?.props.className)).toBe('min-h-[44px]');
  });
});

describe('AdaptiveHomeCardFrame', () => {
  it('reserves height in the layer it does not draw and keeps the drawn layer interactive', () => {
    const renderer = render(false);
    expect(
      renderer.root
        .findAllByType('View' as ElementType)
        .filter(node => node.props.nativeID !== undefined)
        .map(node => `${String(node.props.nativeID)}:${String(node.props.testID)}`)
    ).toEqual(['live:drawn', 'briefing:reserved']);

    const [live, briefing] = layers(renderer);
    expect(live?.props).toMatchObject({
      pointerEvents: 'auto',
      importantForAccessibility: 'auto',
    });
    expect(String(live?.props.className)).not.toContain('opacity-0');
    expect(briefing?.props).toMatchObject({
      pointerEvents: 'none',
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
    expect(String(briefing?.props.className)).toContain('opacity-0');
  });

  it('moves the reserved flag to the live card when the briefing is drawn', () => {
    const renderer = render(true);
    expect(
      renderer.root
        .findAllByType('View' as ElementType)
        .filter(node => node.props.nativeID !== undefined)
        .map(node => `${String(node.props.nativeID)}:${String(node.props.testID)}`)
    ).toEqual(['live:reserved', 'briefing:drawn']);

    const [live, briefing] = layers(renderer);
    expect(String(live?.props.className)).toContain('opacity-0');
    expect(briefing?.props).toMatchObject({
      pointerEvents: 'auto',
      importantForAccessibility: 'auto',
    });
    expect(String(briefing?.props.className)).not.toContain('opacity-0');
  });
});
