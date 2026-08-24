/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as screen-header.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { EmptyFilesView, TabStateMessage } from './pr-diff-hunk-rows';

const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
}));
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
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function rootView(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const views = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'View'
  );
  const root = views[0];
  if (!root) {
    throw new Error('root View not found');
  }
  return root;
}

function paddingBottom(renderer: TestRenderer.ReactTestRenderer): number | undefined {
  return (rootView(renderer).props.style as { paddingBottom?: number } | undefined)?.paddingBottom;
}

describe('TabStateMessage bottom inset (plan §6)', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
  });

  it('pads the terminal message by the detail-screen padding at a zero inset', () => {
    const renderer = mountNode(
      createElement(TabStateMessage, { title: 'Access denied', message: 'No access.' })
    );

    expect(paddingBottom(renderer)).toBe(32);
  });

  it('grows the terminal message padding with a nonzero system inset', () => {
    insetsState.bottom = 34;
    const renderer = mountNode(
      createElement(TabStateMessage, { title: 'Access denied', message: 'No access.' })
    );

    expect(paddingBottom(renderer)).toBe(50);
  });
});

describe('EmptyFilesView bottom inset (plan §6)', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
  });

  it('pads the empty state by the detail-screen padding at a zero inset', () => {
    const renderer = mountNode(createElement(EmptyFilesView, { changedFiles: 0 }));

    expect(paddingBottom(renderer)).toBe(32);
  });

  it('grows the empty state padding with a nonzero system inset', () => {
    insetsState.bottom = 34;
    const renderer = mountNode(createElement(EmptyFilesView, { changedFiles: 0 }));

    expect(paddingBottom(renderer)).toBe(50);
  });

  it('keeps the Overview CTA inside the padded empty state', () => {
    const onRequestOverview = vi.fn(() => undefined);
    const renderer = mountNode(
      createElement(EmptyFilesView, { changedFiles: 0, onRequestOverview })
    );

    expect(paddingBottom(renderer)).toBe(32);
    const cta = renderer.root.findByProps({ accessibilityLabel: 'Go to Overview tab' });
    expect(cta).toBeTruthy();
  });
});
