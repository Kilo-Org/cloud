import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ReadMarkdownBody } from './read-markdown-body';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => true,
}));
vi.mock('./chat-markdown-text', () => ({ ChatMarkdownText: 'ChatMarkdownText' }));

/** A markdown body over 2000 chars — the removed inline cap. */
const longText = `${'# Heading\n'.repeat(50)}\n`.repeat(20);

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
      const props = value.props as Record<string, unknown>;
      // Walk the rendered output of function components so their
      // children are visible to predicate matching.
      if (typeof value.type === 'function') {
        walk((value.type as React.FunctionComponent<unknown>)(props));
      }
      walk(props.children);
    }
  }
  walk(node);
  return matches;
}

function findByType(root: React.ReactElement, type: string): React.ReactElement[] {
  return findAll(root, el => el.type === type);
}

describe('ReadMarkdownBody', () => {
  it('renders the full markdown with no nested tap action', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ReadMarkdownBody({
      body: { text: longText, footer: undefined },
    }) as unknown as React.ReactElement;
    const markdown = findByType(root, 'ChatMarkdownText');
    expect(markdown).toHaveLength(1);
    const markdownElement = markdown[0];
    if (!markdownElement) {
      throw new Error('markdown not found');
    }
    expect((markdownElement.props as { value?: unknown }).value).toBe(longText);
    expect((markdownElement.props as { selectable?: unknown }).selectable).toBe(true);
    expect(findByType(root, 'Pressable')).toHaveLength(0);
  });

  it('renders the footer text when present', () => {
    const footer = 'lines 201–400 of 1,450';
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ReadMarkdownBody({
      body: { text: '# Title', footer },
    }) as unknown as React.ReactElement;
    const texts = findByType(root, 'Text');
    expect(texts.some(el => (el.props as { children?: unknown }).children === footer)).toBe(true);
  });

  it('shows the empty-file line and no markdown for an empty body', () => {
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = ReadMarkdownBody({
      body: { text: '', footer: undefined },
    }) as unknown as React.ReactElement;
    const texts = findByType(root, 'Text');
    expect(
      texts.some(el => (el.props as { children?: unknown }).children === 'This file is empty.')
    ).toBe(true);
    expect(findByType(root, 'ChatMarkdownText')).toHaveLength(0);
  });
});
