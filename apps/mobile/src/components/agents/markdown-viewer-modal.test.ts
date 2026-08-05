import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { MarkdownViewerModal } from './markdown-viewer-modal';

vi.mock('react-native', () => ({
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('lucide-react-native', () => ({ X: 'X' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000' }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('./markdown-text', () => ({ MarkdownText: 'MarkdownText' }));

function render(path: string, value: string, footer?: string): React.ReactElement {
  // eslint-disable-next-line new-cap
  return MarkdownViewerModal({
    visible: true,
    path,
    value,
    footer,
    onClose: () => undefined,
  }) as React.ReactElement;
}

function findAll(
  node: unknown,
  predicate: (el: React.ReactElement) => boolean
): React.ReactElement[] {
  const matches: React.ReactElement[] = [];

  function walk(value: unknown): void {
    if (value == null || typeof value === 'string' || typeof value === 'number') {
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
      return;
    }
    if (React.isValidElement(value)) {
      if (predicate(value)) {
        matches.push(value);
      }
      const props = value.props as { children?: unknown };
      walk(props.children);
    }
  }

  walk(node);
  return matches;
}

function findByType(root: React.ReactElement, type: string): React.ReactElement[] {
  return findAll(root, el => el.type === type);
}

function rootElement(node: React.ReactElement | null): React.ReactElement {
  if (!node) {
    throw new Error('expected a root element');
  }
  return node;
}

describe('MarkdownViewerModal', () => {
  it('labels the close button with the filename and keeps the full path as the title', () => {
    const root = rootElement(render('/repo/docs/README.md', '# README'));
    const close = findByType(root, 'Pressable')[0];
    expect(close).toBeDefined();
    if (!close) {
      throw new Error('close pressable not found');
    }
    expect((close.props as { accessibilityLabel?: string }).accessibilityLabel).toBe(
      'Close README.md'
    );
    const title = findByType(root, 'Text').find(
      el => (el.props as { children?: string }).children === '/repo/docs/README.md'
    );
    expect(title).toBeDefined();
  });

  it('passes the full document value to MarkdownText', () => {
    const document = '# Title\n\nBody paragraph with **bold** text.';
    const root = rootElement(render('/repo/docs/README.md', document));
    const markdown = findByType(root, 'MarkdownText')[0];
    expect(markdown).toBeDefined();
    if (!markdown) {
      throw new Error('MarkdownText not found');
    }
    expect((markdown.props as { value?: string }).value).toBe(document);
  });

  it('renders the footer text and a scroll view when a footer is provided', () => {
    const root = rootElement(render('/repo/notes.md', '# Notes', 'lines 1–2 of 4'));
    expect(findByType(root, 'ScrollView')).toHaveLength(1);
    const footer = findByType(root, 'Text').find(
      el => (el.props as { children?: string }).children === 'lines 1–2 of 4'
    );
    expect(footer).toBeDefined();
  });
});
