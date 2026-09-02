/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as screen-header.mounted.test.tsx) */
import { createElement } from 'react';
import { RefreshControl } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { EmptyFilesView, TabStateMessage } from './pr-diff-hunk-rows';

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  File: 'File',
  GitCommit: 'GitCommit',
  X: 'X',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));

function mountNode(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(node);
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

function centeredContent(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(node => String(node.type) === 'CenteredState');
}

describe('Files pane full-body states', () => {
  it('centers the terminal message without local bottom padding', () => {
    const renderer = mountNode(
      createElement(TabStateMessage, { title: 'Access denied', message: 'No access.' })
    );
    expect(centeredContent(renderer).findByProps({ children: 'No access.' })).toBeDefined();
    expect(
      renderer.root.findAll(
        node =>
          (node.props.style as { paddingBottom?: number } | undefined)?.paddingBottom !== undefined
      )
    ).toHaveLength(0);
  });

  it.each([0, 2])('centers the empty or waiting body for %s reported files', changedFiles => {
    const renderer = mountNode(createElement(EmptyFilesView, { changedFiles }));
    expect(centeredContent(renderer)).toBeDefined();
    const texts = renderer.root.findAll(node => String(node.type) === 'Text');
    expect(
      texts.some(node =>
        String(node.props.children).includes(changedFiles === 0 ? 'No files' : 'loading')
      )
    ).toBe(true);
  });

  it('passes refresh to the single centered scroller in the waiting body', () => {
    const refreshControl = createElement(RefreshControl, { refreshing: false });
    const renderer = mountNode(createElement(EmptyFilesView, { changedFiles: 2, refreshControl }));
    const centered = centeredContent(renderer);
    expect(renderer.root.findAll(node => String(node.type) === 'CenteredState')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    expect(centered.props.refreshControl).toBe(refreshControl);
    expect(
      centered.findByProps({ children: 'Files are still loading. Pull to refresh.' })
    ).toBeDefined();
  });

  it('keeps the Overview action inside the centered body', () => {
    const onRequestOverview = vi.fn<() => void>();
    const renderer = mountNode(
      createElement(EmptyFilesView, { changedFiles: 0, onRequestOverview })
    );
    const cta = centeredContent(renderer).findByProps({ accessibilityLabel: 'Go to Overview tab' });
    act(() => {
      (cta.props.onPress as () => void)();
    });
    expect(onRequestOverview).toHaveBeenCalledOnce();
  });
});
