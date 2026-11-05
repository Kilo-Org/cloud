import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActivityIndicator } from './activity-indicator';

const motion = vi.hoisted(() => ({ reducedMotion: true }));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ Loader2: 'Loader2' }));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: motion.reducedMotion, scrollAnimated: false }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type Renderer = TestRenderer.ReactTestRenderer;
type IndicatorProps = Parameters<typeof ActivityIndicator>[0];

async function mount(props: IndicatorProps): Promise<Renderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(ActivityIndicator, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function byType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => node.type === type);
}

function fallback(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const views = byType(root, 'View');
  const wrapper = views[0];
  if (!wrapper) {
    throw new Error('the reduced-motion fallback did not render a wrapper');
  }
  return wrapper;
}

beforeEach(() => {
  motion.reducedMotion = true;
});

describe('ActivityIndicator reduced-motion fallback', () => {
  it('announces the same wait the animated branch shows', async () => {
    const renderer = await mount({});

    const wrapper = fallback(renderer.root);
    expect(wrapper.props.accessible).toBe(true);
    expect(wrapper.props.accessibilityRole).toBe('progressbar');
    expect(wrapper.props.accessibilityLabel).toBe('common.loading');
    expect(wrapper.props.accessibilityState).toEqual({ busy: true });
    expect(wrapper.props.accessibilityElementsHidden).toBe(false);
    expect(wrapper.props.importantForAccessibility).toBe('auto');
    // The static glyph is what the reduced-motion branch paints instead of the
    // native spinner; the wrapper, not the glyph, is the announced element.
    expect(byType(renderer.root, 'Loader2')).toHaveLength(1);
    expect(byType(renderer.root, 'ActivityIndicator')).toHaveLength(0);

    renderer.unmount();
  });

  it('lets the caller name the wait and keep its own state keys', async () => {
    const renderer = await mount({
      accessibilityLabel: 'Uploading photo',
      accessibilityState: { selected: true },
    });

    const wrapper = fallback(renderer.root);
    expect(wrapper.props.accessibilityLabel).toBe('Uploading photo');
    expect(wrapper.props.accessibilityState).toEqual({ selected: true, busy: true });

    renderer.unmount();
  });

  it('honours a caller that marks the indicator decorative', async () => {
    const renderer = await mount({ accessible: false });

    expect(fallback(renderer.root).props.accessible).toBe(false);

    renderer.unmount();
  });

  it('leaves the tree when a stopped indicator hides itself', async () => {
    const renderer = await mount({ animating: false });

    const wrapper = fallback(renderer.root);
    expect(wrapper.props.accessible).toBe(false);
    expect(wrapper.props.accessibilityState).toEqual({ busy: false });
    expect(wrapper.props.accessibilityElementsHidden).toBe(true);
    expect(wrapper.props.importantForAccessibility).toBe('no-hide-descendants');
    // The box stays in layout, so the marker is drawn transparent instead of
    // being removed and shifting the row.
    expect(byType(wrapper, 'Loader2')[0]?.props.color).toBe('transparent');

    renderer.unmount();
  });

  it('keeps a stopped indicator that hides nothing announced but idle', async () => {
    const renderer = await mount({ animating: false, hidesWhenStopped: false, color: '#123456' });

    const wrapper = fallback(renderer.root);
    expect(wrapper.props.accessible).toBe(true);
    expect(wrapper.props.accessibilityState).toEqual({ busy: false });
    expect(wrapper.props.accessibilityElementsHidden).toBe(false);
    expect(byType(wrapper, 'Loader2')[0]?.props.color).toBe('#123456');

    renderer.unmount();
  });

  it('leaves the animated branch to the platform indicator', async () => {
    motion.reducedMotion = false;
    const renderer = await mount({ color: '#123456' });

    const [indicator] = byType(renderer.root, 'ActivityIndicator');
    expect(indicator?.props.animating).toBe(true);
    expect(indicator?.props.color).toBe('#123456');
    expect(indicator?.props.accessibilityRole).toBeUndefined();
    expect(byType(renderer.root, 'View')).toHaveLength(0);

    renderer.unmount();
  });
});
