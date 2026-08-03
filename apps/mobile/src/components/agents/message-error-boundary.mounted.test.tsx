/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
/* eslint-disable no-empty-function -- the console.warn spy body is intentionally empty */
/* eslint-disable no-inline-comments -- inline comments document test state transitions */
import { createElement, type ReactElement, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { MessageErrorBoundary } from './message-error-boundary';

type WrapperProps = {
  children?: ReactNode;
  fallback?: ReactNode;
  resetKey?: number;
};

/**
 * Wraps MessageErrorBoundary so that children are passed as the third
 * createElement argument. Optional children keep the TypeScript call
 * clean without a type assertion or a children key in the props object.
 */
function BoundaryWrapper({ children, fallback, resetKey }: WrapperProps): ReactElement {
  return (
    <MessageErrorBoundary fallback={fallback} resetKey={resetKey}>
      {children}
    </MessageErrorBoundary>
  );
}

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let shouldThrow = false;

function MaybeBoom(): ReactElement {
  if (shouldThrow) {
    throw new Error('boom');
  }
  return createElement('View', null, 'safe');
}

function FallbackNode(): ReactElement {
  return createElement('Text', null, 'custom fallback');
}

function renderBoundary(
  child: ReactNode,
  props: Omit<WrapperProps, 'children'> = {}
): TestRenderer.ReactTestRenderer {
  return TestRenderer.create(createElement(BoundaryWrapper, props, child));
}

describe('MessageErrorBoundary mounted', () => {
  it('renders custom fallback when child throws', async () => {
    shouldThrow = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // eslint-disable-line no-empty-function

    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = renderBoundary(createElement(MaybeBoom), {
        fallback: createElement(FallbackNode),
      });
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    const textNodes = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Text'
    );
    expect(textNodes.length).toBe(1);
    const firstText = textNodes[0];
    if (!firstText) {
      throw new Error('expected firstText to be defined');
    }
    expect(firstText.props.children).toBe('custom fallback');

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('recovers child render after resetKey increments', async () => {
    shouldThrow = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // eslint-disable-line no-empty-function

    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };

    // First render: child throws, fallback shown.
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = renderBoundary(createElement(MaybeBoom), {
        fallback: createElement(FallbackNode),
        resetKey: 0,
      });
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Text'
      ).length
    ).toBe(1);

    // Second render: child stops throwing, resetKey increments.
    shouldThrow = false;
    await act(async () => {
      await Promise.resolve();
      renderer.update(
        createElement(
          BoundaryWrapper,
          { fallback: createElement(FallbackNode), resetKey: 1 },
          createElement(MaybeBoom)
        )
      );
    });

    // Child recovered: View node with "safe" proves MaybeBoom rendered.
    const recoveredViews = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'View'
    );
    expect(recoveredViews.length).toBe(1);
    const firstView = recoveredViews[0];
    if (!firstView) {
      throw new Error('expected firstView to be defined');
    }
    expect(firstView.props.children).toBe('safe');

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('renders default tile when no fallback prop is given and child throws', async () => {
    shouldThrow = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // eslint-disable-line no-empty-function

    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = renderBoundary(createElement(MaybeBoom));
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    // Default tile includes the "Failed to render content" Text.
    const textNodes = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Text'
    );
    expect(textNodes.length).toBe(1);
    const textNode = textNodes[0];
    if (!textNode) {
      throw new Error('expected textNode to be defined');
    }
    expect(textNode.props.children).toBe('Failed to render content');

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });
});
