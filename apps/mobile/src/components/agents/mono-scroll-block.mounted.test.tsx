/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { MonoScrollBlock } from './mono-scroll-block';

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('react-native-gesture-handler', () => ({
  ScrollView: 'ScrollView',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/components/ui/selectable-text', () => ({
  SelectableText: 'SelectableText',
}));
vi.mock('./bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => false,
}));

async function renderBlock(props: {
  content: string;
  maxLength?: number;
  inTranscript?: boolean;
}): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(MonoScrollBlock, props));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('MonoScrollBlock mounted', () => {
  it('defaults to SelectableText and wires onLayout for the height pin', async () => {
    const content = 'line one\nline two';
    const renderer = await renderBlock({ content });

    const selectableHosts = renderer.root.findAll(
      node => (node.type as string) === 'SelectableText'
    );
    expect(selectableHosts).toHaveLength(1);
    expect(selectableHosts[0]?.props.children).toBe(content);
    // The height pin measures from the content's layout, so the sheet branch
    // must forward onLayout; a later edit dropping it would break the pin.
    expect(typeof selectableHosts[0]?.props.onLayout).toBe('function');

    // The sheet branch must not render the transcript Text.
    expect(renderer.root.findAll(node => (node.type as string) === 'Text')).toHaveLength(0);
  });

  it('keeps the transcript on Text when inTranscript is set', async () => {
    const content = 'transcript output';
    const renderer = await renderBlock({ content, inTranscript: true });

    const textHosts = renderer.root.findAll(
      node => (node.type as string) === 'Text' && node.props.children === content
    );
    expect(textHosts).toHaveLength(1);
    // A UITextView must never land inside the transcript FlashList.
    expect(renderer.root.findAll(node => (node.type as string) === 'SelectableText')).toHaveLength(
      0
    );
  });
});
