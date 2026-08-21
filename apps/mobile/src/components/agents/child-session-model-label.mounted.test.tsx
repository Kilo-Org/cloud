/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/ui/selectable-text.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ChildSessionModelLabel } from './child-session-model-label';

// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose node_modules
// `.mjs` contains JSX that this pipeline cannot transform. Provide a real context
// so any `useContext(TextClassContext)` consumer still resolves.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});

describe('ChildSessionModelLabel mounted', () => {
  it('renders the literal Model: accessibility label with the model name as text', async () => {
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(ChildSessionModelLabel, { modelLabel: 'Claude Sonnet 4' })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const nodes = renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Model: Claude Sonnet 4'
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.children).toEqual(['Claude Sonnet 4']);
  });
});
