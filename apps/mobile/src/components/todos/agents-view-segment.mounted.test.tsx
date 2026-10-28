import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type AgentsView, AgentsViewSegment } from './agents-view-segment';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('Agents view tabs', () => {
  it('announces the selected view and switches only when another tab is pressed', () => {
    const onChange = vi.fn<(view: AgentsView) => void>();
    act(() => {
      renderer = TestRenderer.create(
        createElement(AgentsViewSegment, { value: 'sessions', onChange })
      );
    });
    if (!renderer) {
      throw new Error('Missing Agents tabs');
    }
    const tabs = renderer.root.findAll(
      node =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.accessibilityState === 'object' &&
        node.props.accessibilityState !== null &&
        'selected' in node.props.accessibilityState
    );
    const [sessions, todos] = tabs;
    if (!sessions || !todos) {
      throw new Error('Missing Agents tabs');
    }
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.props.accessibilityState).toEqual({ selected: true });
    expect(tabs[1]?.props.accessibilityState).toEqual({ selected: false });

    act(() => {
      (sessions.props.onPress as () => void)();
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      (todos.props.onPress as () => void)();
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('todos');
  });
});
