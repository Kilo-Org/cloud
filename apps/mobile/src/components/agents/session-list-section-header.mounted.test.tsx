import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { SessionListSectionHeader } from './session-list-section-header';
import '@/i18n';

// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose node_modules
// `.mjs` contains JSX that this pipeline cannot transform. Provide a real context
// so any `useContext(TextClassContext)` consumer still resolves.
vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});

describe('SessionListSectionHeader mounted', () => {
  it('exposes the title and its count as one element with a header role', async () => {
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(SessionListSectionHeader, {
          title: 'Friday',
          count: 2,
          accessibilityLabel: 'Friday, 2 sessions',
        })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const headings = renderer.root.findAll(node => node.props.accessibilityRole === 'header');
    expect(headings).toHaveLength(1);
    const heading = headings[0];
    expect(heading?.props.accessible).toBe(true);
    expect(heading?.props.accessibilityLabel).toBe('Friday, 2 sessions');

    // The visible row still shows the title and the count as separate parts,
    // nested inside the heading that now carries the spoken label.
    const parts = heading?.children.filter((child): child is string => typeof child !== 'string');
    expect(parts).toHaveLength(2);
  });

  it('keeps the visible count in the active language', async () => {
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(SessionListSectionHeader, {
          title: 'Friday',
          count: 2,
          accessibilityLabel: 'Friday, 2 sessions',
        })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    expect(renderer.root.findAll(node => node.props.children === '2')).toHaveLength(1);
  });
});