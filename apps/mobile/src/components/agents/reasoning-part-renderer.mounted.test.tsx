/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ReasoningPartRenderer } from './reasoning-part-renderer';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
}));
vi.mock('@/components/ui/eyebrow', () => ({
  Eyebrow: 'Eyebrow',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedSoft: '#999999' }),
}));
vi.mock('./bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => false,
}));

/** Find the body element that contains the reasoning text (View right after the Pressable). */
function findTextElement(
  root: TestRenderer.ReactTestInstance
): TestRenderer.ReactTestInstance | undefined {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Text' &&
      typeof node.props.children === 'string'
  );
}

describe('ReasoningPartRenderer mounted', () => {
  it('shows text without entering animation on first mount', async () => {
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(ReasoningPartRenderer, {
          text: 'First reasoning step',
          isStreaming: false,
          defaultExpanded: true,
        })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const textEl = findTextElement(renderer.root);
    expect(textEl).toBeDefined();
    expect(textEl?.props.children).toBe('First reasoning step');

    // The body element must not have an entering prop (animation removed).
    // After the fix, the body is a plain View, not an Animated.View.
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

  it('shows text without entering animation on recycled mount', async () => {
    const firstRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      firstRef.current = TestRenderer.create(
        createElement(ReasoningPartRenderer, {
          text: 'Recycled reasoning',
          isStreaming: false,
          defaultExpanded: true,
        })
      );
    });
    const firstRenderer = firstRef.current;
    if (!firstRenderer) {
      throw new Error('first renderer was not created');
    }
    // Unmount
    await act(async () => {
      await Promise.resolve();
      firstRenderer.unmount();
    });

    // Second mount (recycled)
    const secondRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      secondRef.current = TestRenderer.create(
        createElement(ReasoningPartRenderer, {
          text: 'Recycled reasoning',
          isStreaming: false,
          defaultExpanded: true,
        })
      );
    });
    const secondRenderer = secondRef.current;
    if (!secondRenderer) {
      throw new Error('second renderer was not created');
    }

    const textEl = findTextElement(secondRenderer.root);
    expect(textEl).toBeDefined();
    expect(textEl?.props.children).toBe('Recycled reasoning');

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

  it('returns null for blank (empty string) text', async () => {
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(ReasoningPartRenderer, {
          text: '',
          isStreaming: false,
          defaultExpanded: true,
        })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    // The renderer returns null, so the tree should have no children.
    expect(renderer.root.children).toHaveLength(0);
  });

  it('returns null for whitespace-only text', async () => {
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(ReasoningPartRenderer, {
          text: '   \n\t  ',
          isStreaming: false,
          defaultExpanded: true,
        })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    expect(renderer.root.children).toHaveLength(0);
  });
});
