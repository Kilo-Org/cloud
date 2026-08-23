/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import '@/i18n';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { OpenPartDetailContext } from './open-part-detail-context';
import { ReasoningPartRenderer } from './reasoning-part-renderer';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/eyebrow', () => ({
  Eyebrow: 'Eyebrow',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('./bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => false,
}));
vi.mock('./fixed-part-row', () => ({
  FixedPartRow: 'FixedPartRow',
}));

/** Find the body element that contains the reasoning text (a Text host with the raw text). */
function findTextElement(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance | undefined {
  const matches = root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      typeof node.props.children === 'string'
  );
  return matches[0];
}

/** Mount the renderer with the optional detail opener context value. */
async function renderRenderer(props: {
  partId: string;
  text: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  openPartDetail?: (partId: string) => void;
}): Promise<TestRenderer.ReactTestRenderer> {
  const { openPartDetail, ...rendererProps } = props;
  const element = createElement(
    OpenPartDetailContext.Provider,
    { value: openPartDetail ?? null },
    createElement(ReasoningPartRenderer, rendererProps)
  );
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(element);
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('ReasoningPartRenderer mounted', () => {
  it('expanded mode renders the full text with no Pressable and no entering animation', async () => {
    const renderer = await renderRenderer({
      partId: 'p1',
      text: 'First reasoning step',
      isStreaming: false,
      defaultExpanded: true,
    });

    const textEl = findTextElement(renderer.root);
    expect(textEl).toBeDefined();
    expect(textEl?.props.children).toBe('First reasoning step');

    // Expanded mode is static: no toggle control in the tree.
    expect(renderer.root.findAll(node => (node.type as string) === 'Pressable')).toHaveLength(0);

    // The body element must not have an entering prop (animation removed).
    // The body is a plain View, not an Animated.View.
    /* eslint-disable typescript-eslint/no-unsafe-member-access */
    const bodyViews = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        node.props.className === 'mt-2'
    );
    expect(bodyViews.length).toBe(1);
    expect(bodyViews[0]?.props.entering).toBeUndefined();
    /* eslint-enable typescript-eslint/no-unsafe-member-access */
  });

  it('expanded mode stays static on a recycled mount', async () => {
    const firstRenderer = await renderRenderer({
      partId: 'p1',
      text: 'Recycled reasoning',
      isStreaming: false,
      defaultExpanded: true,
    });
    // Unmount
    await act(async () => {
      await Promise.resolve();
      firstRenderer.unmount();
    });

    // Second mount (recycled)
    const secondRenderer = await renderRenderer({
      partId: 'p1',
      text: 'Recycled reasoning',
      isStreaming: false,
      defaultExpanded: true,
    });

    const textEl = findTextElement(secondRenderer.root);
    expect(textEl).toBeDefined();
    expect(textEl?.props.children).toBe('Recycled reasoning');

    expect(secondRenderer.root.findAll(node => (node.type as string) === 'Pressable')).toHaveLength(
      0
    );

    /* eslint-disable typescript-eslint/no-unsafe-member-access */
    const bodyViews = secondRenderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        node.props.className === 'mt-2'
    );
    expect(bodyViews.length).toBe(1);
    expect(bodyViews[0]?.props.entering).toBeUndefined();
    /* eslint-enable typescript-eslint/no-unsafe-member-access */
  });

  it('collapsed mode renders one fixed row and pressing it opens the part id through context', async () => {
    const openPartDetail = vi.fn((_partId: string) => undefined);
    const renderer = await renderRenderer({
      partId: 'part-1',
      text: 'Hidden reasoning text',
      isStreaming: false,
      openPartDetail,
    });

    // No body text in collapsed mode.
    expect(findTextElement(renderer.root)).toBeUndefined();

    const rows = renderer.root.findAll(node => (node.type as string) === 'FixedPartRow');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) {
      throw new Error('row not found');
    }
    expect(row.props.label).toBe('Thought');
    expect(row.props.labelKind).toBe('eyebrow');
    expect(row.props.variant).toBe('dashed');
    expect(row.props.accessibilityLabel).toBe('Thought');

    // Pressing the row calls the opener with the supplied part id.
    /* eslint-disable typescript-eslint/no-unsafe-member-access */
    const onPress = row.props.onPress as () => void;
    /* eslint-enable typescript-eslint/no-unsafe-member-access */
    await act(async () => {
      await Promise.resolve();
      onPress();
    });
    expect(openPartDetail).toHaveBeenCalledWith('part-1');
  });

  it('collapsed mode labels a streaming part as Thinking', async () => {
    const renderer = await renderRenderer({
      partId: 'part-1',
      text: 'Streaming reasoning',
      isStreaming: true,
    });

    const rows = renderer.root.findAll(node => (node.type as string) === 'FixedPartRow');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.props.label).toBe('Thinking');
    expect(rows[0]?.props.accessibilityLabel).toBe('Thinking');
  });

  it('collapsed mode keeps the row visible but non-pressable without an opener', async () => {
    const renderer = await renderRenderer({
      partId: 'part-1',
      text: 'Hidden reasoning text',
      isStreaming: false,
    });

    const rows = renderer.root.findAll(node => (node.type as string) === 'FixedPartRow');
    expect(rows).toHaveLength(1);
    // No context opener: the row stays visible with no press wiring.
    expect(rows[0]?.props.onPress).toBeUndefined();
  });

  it('returns null for blank (empty string) text', async () => {
    const renderer = await renderRenderer({
      partId: 'p1',
      text: '',
      isStreaming: false,
      defaultExpanded: true,
    });
    // The renderer returns null, so the tree should have no children.
    expect(renderer.root.children).toHaveLength(0);
  });

  it('returns null for whitespace-only text', async () => {
    const renderer = await renderRenderer({
      partId: 'p1',
      text: '   \n\t  ',
      isStreaming: false,
      defaultExpanded: true,
    });
    expect(renderer.root.children).toHaveLength(0);
  });
});
