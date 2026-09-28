import { createElement } from 'react';
import { RefreshControl } from '@/components/ui/refresh-control';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { EmptyFilesView, HunkHeaderRow, PaginationRow, TabStateMessage } from './pr-diff-hunk-rows';

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
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

describe('HunkHeaderRow code direction', () => {
  // The header is a code literal ("@@ -0,0 +1,82 @@"). Under the interface's
  // RTL base direction its runs reorder — the "+"/"-" land on the wrong side of
  // their numbers and the ranges swap ends — so the header names its own
  // left-to-right direction, like the diff lines below it.
  it('names the left-to-right base direction on the header text', () => {
    const renderer = mountNode(createElement(HunkHeaderRow, { header: '@@ -0,0 +1,82 @@' }));

    const [headerText] = renderer.root.findAll(node => String(node.type) === 'Text');
    if (headerText === undefined) {
      throw new Error('expected the hunk header text');
    }
    const style = headerText.props.style as { direction?: string; writingDirection?: string };
    expect(style.direction).toBe('ltr');
    expect(style.writingDirection).toBe('ltr');
  });
});

describe('PaginationRow', () => {
  function renderPaginationRow() {
    const renderer = mountNode(
      createElement(PaginationRow, {
        state: 'no-pages',
        loadedFiles: 1,
        totalFiles: 5,
        onRetry: vi.fn<() => void>(),
        onFetchAll: vi.fn<() => void>(),
      })
    );
    return renderer.root
      .findAll(node => String(node.type) === 'Text')
      .map(node => String(node.props.children));
  }

  it('reads the one-file page as plural files, naming the whole page set', () => {
    expect(renderPaginationRow()).toContain('1 of 5 files loaded');
  });

  // The count handed to i18next picks the plural category. It must be the
  // loaded count, because the catalogs inflect the participle on the loaded
  // number — French says "1 fichier chargé sur 5", not the plural
  // "1 fichiers chargés sur 5" a total-keyed category renders.
  it('keys the plural category on the loaded count, not the total', async () => {
    await i18n.changeLanguage('fr');
    try {
      expect(renderPaginationRow()).toContain('1 fichier chargé sur 5');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
