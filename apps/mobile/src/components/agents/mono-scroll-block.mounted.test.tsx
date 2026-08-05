/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement, type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { type MonoScrollTextMode } from './mono-scroll-block-model';
import { MonoScrollBlock, MonoScrollSheetProvider } from './mono-scroll-block';

// RNGH ships Flow source that the node project cannot parse, so the horizontal
// ScrollView becomes a string element; `LayoutChangeEvent` is type-only.
vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('react-native-gesture-handler', () => ({
  ScrollView: 'ScrollView',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('./bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => true,
}));

/** 300+ char single-line payload, like a long tool output line. */
const LONG_LINE = `${'x'.repeat(300)} tail`;

const NOOP_TRACK: () => () => void = () => () => {
  // Presence is asserted through spies in the registration tests.
};

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function propOf(instance: TestRenderer.ReactTestInstance | undefined, key: string): unknown {
  if (!instance) {
    return undefined;
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

/** The mono Text: the one Text child carrying the long payload. */
function monoText(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const found = root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      typeof propOf(node, 'children') === 'string' &&
      (propOf(node, 'children') as string).length > 50
  );
  const [text] = found;
  if (!text) {
    throw new Error(`expected exactly one mono text, found ${found.length}`);
  }
  return text;
}

function truncatedMarkers(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      propOf(node, 'accessibilityLabel') === 'Content truncated'
  );
}

async function mount(element: ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(element);
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function unmount(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.unmount();
  });
}

function withSheet(
  mode: MonoScrollTextMode,
  track: () => () => void,
  block: ReactElement
): ReactElement {
  const value = { mode, track };
  return <MonoScrollSheetProvider value={value}>{block}</MonoScrollSheetProvider>;
}

function blockElement(maxLength?: number): ReactElement {
  return createElement(MonoScrollBlock, { content: LONG_LINE, maxLength });
}

function fireLayout(text: TestRenderer.ReactTestInstance, height: number): void {
  const onLayout = propOf(text, 'onLayout');
  (
    onLayout as (event: {
      nativeEvent: { layout: { x: number; y: number; width: number; height: number } };
    }) => void
  )({ nativeEvent: { layout: { x: 0, y: 0, width: 100, height } } });
}

describe('MonoScrollBlock mounted', () => {
  it('renders the scroll branch with transcript defaults outside the sheet', async () => {
    const renderer = await mount(blockElement());

    const scrollViews = findByType(renderer.root, 'ScrollView');
    expect(scrollViews).toHaveLength(1);
    expect(propOf(scrollViews[0], 'horizontal')).toBe(true);
    expect(propOf(scrollViews[0], 'showsHorizontalScrollIndicator')).toBe(true);
    expect(propOf(monoText(renderer.root), 'className') as string).toContain('shrink-0 self-start');

    await unmount(renderer);
  });

  it('keeps the full scroll contract under the sheet in scroll mode', async () => {
    const unregister = vi.fn();
    const track = vi.fn(() => unregister);
    const renderer = await mount(withSheet('scroll', track, blockElement()));

    const scrollViews = findByType(renderer.root, 'ScrollView');
    expect(scrollViews).toHaveLength(1);
    expect(propOf(scrollViews[0], 'horizontal')).toBe(true);
    expect(propOf(scrollViews[0], 'showsHorizontalScrollIndicator')).toBe(true);

    const text = monoText(renderer.root);
    expect(propOf(text, 'selectable')).toBe(true);
    expect(propOf(text, 'className') as string).toContain('shrink-0 self-start');

    // Height pin: measuring the content pins the ScrollView height.
    await act(async () => {
      await Promise.resolve();
      fireLayout(text, 48);
    });
    expect(propOf(findByType(renderer.root, 'ScrollView')[0], 'style')).toEqual({ height: 48 });

    expect(track).toHaveBeenCalledTimes(1);

    await unmount(renderer);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('renders the truncated marker in scroll mode when maxLength is exceeded', async () => {
    const renderer = await mount(withSheet('scroll', NOOP_TRACK, blockElement(200)));

    expect(monoText(renderer.root)).toBeTruthy();
    expect(truncatedMarkers(renderer.root)).toHaveLength(1);

    await unmount(renderer);
  });

  it('renders plain wrapped text with no scroller in wrap mode', async () => {
    const renderer = await mount(withSheet('wrap', NOOP_TRACK, blockElement()));

    expect(findByType(renderer.root, 'ScrollView')).toHaveLength(0);
    const text = monoText(renderer.root);
    expect(propOf(text, 'selectable')).toBe(true);
    const className = propOf(text, 'className') as string;
    expect(className).toContain('font-mono text-xs leading-4');
    expect(className).not.toContain('shrink-0');

    await unmount(renderer);
  });

  it('renders the truncated marker in wrap mode when maxLength is exceeded', async () => {
    const renderer = await mount(withSheet('wrap', NOOP_TRACK, blockElement(200)));

    expect(findByType(renderer.root, 'ScrollView')).toHaveLength(0);
    expect(truncatedMarkers(renderer.root)).toHaveLength(1);

    await unmount(renderer);
  });

  it('registers presence once on mount and unregisters on unmount', async () => {
    const unregister = vi.fn();
    const track = vi.fn(() => unregister);
    const renderer = await mount(withSheet('wrap', track, blockElement()));

    expect(track).toHaveBeenCalledTimes(1);

    await unmount(renderer);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('does not re-register when the mode flips — track identity stays stable', async () => {
    const unregister = vi.fn();
    const track = vi.fn(() => unregister);
    const renderer = await mount(withSheet('wrap', track, blockElement()));
    expect(track).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
      renderer.update(withSheet('scroll', track, blockElement()));
    });
    expect(track).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
      renderer.update(withSheet('wrap', track, blockElement()));
    });
    expect(track).toHaveBeenCalledTimes(1);

    await unmount(renderer);
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
