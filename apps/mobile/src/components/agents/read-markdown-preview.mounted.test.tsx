/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ReadMarkdownPreview } from './read-markdown-preview';
import { type MarkdownPreview } from './read-tool-markdown';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('lucide-react-native', () => ({ BookOpen: 'BookOpen' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));
vi.mock('./bubble-text-selection-context', () => ({
  useTranscriptTextSelectable: () => true,
}));
vi.mock('./chat-markdown-text', () => ({ ChatMarkdownText: 'ChatMarkdownText' }));
vi.mock('./markdown-viewer-modal', () => ({ MarkdownViewerModal: 'MarkdownViewerModal' }));

function makePreview(overrides: Partial<MarkdownPreview> = {}): MarkdownPreview {
  return {
    path: '/repo/notes.md',
    text: 'full markdown body',
    inlineText: 'capped inline body',
    inlineTruncated: false,
    footer: undefined,
    ...overrides,
  };
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function isDescendantOf(instance: TestRenderer.ReactTestInstance, type: string): boolean {
  let node = instance.parent;
  while (node) {
    if (node.type === type) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

async function mountPreview(preview: MarkdownPreview): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(ReadMarkdownPreview, { preview }));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('ReadMarkdownPreview mounted', () => {
  it('shows one read-full pressable that opens the reader with the full value when truncated', async () => {
    const preview = makePreview({ inlineTruncated: true, footer: 'lines 1–200 of 1,450' });
    const renderer = await mountPreview(preview);

    const pressables = findByType(renderer.root, 'Pressable');
    expect(pressables).toHaveLength(1);
    const affordance = pressables[0];
    if (!affordance) {
      throw new Error('pressable not found');
    }
    expect(affordance.props.accessibilityLabel).toBe('Read notes.md in full');

    const chatMarkdown = findByType(renderer.root, 'ChatMarkdownText')[0];
    expect(chatMarkdown).toBeDefined();
    if (!chatMarkdown) {
      throw new Error('ChatMarkdownText not found');
    }
    expect(isDescendantOf(chatMarkdown, 'Pressable')).toBe(false);

    const modal = findByType(renderer.root, 'MarkdownViewerModal')[0];
    expect(modal).toBeDefined();
    if (!modal) {
      throw new Error('MarkdownViewerModal not found');
    }
    expect(modal.props.visible).toBe(false);

    await act(async () => {
      await Promise.resolve();
      (affordance.props.onPress as () => void)();
    });

    const openModal = findByType(renderer.root, 'MarkdownViewerModal')[0];
    if (!openModal) {
      throw new Error('MarkdownViewerModal not found after press');
    }
    expect(openModal.props.visible).toBe(true);
    expect(openModal.props.value).toBe(preview.text);
    expect(openModal.props.path).toBe(preview.path);
    expect(openModal.props.footer).toBe(preview.footer);
  });

  it('renders the footer and mounts the hidden modal when not truncated', async () => {
    const preview = makePreview({ footer: 'lines 1–2 of 4' });
    const renderer = await mountPreview(preview);

    expect(findByType(renderer.root, 'Pressable')).toHaveLength(0);

    const modal = findByType(renderer.root, 'MarkdownViewerModal')[0];
    expect(modal).toBeDefined();
    if (!modal) {
      throw new Error('MarkdownViewerModal not found');
    }
    expect(modal.props.visible).toBe(false);

    const footerTexts = findByType(renderer.root, 'Text').filter(
      node => node.props.children === 'lines 1–2 of 4'
    );
    expect(footerTexts).toHaveLength(1);
  });

  it('renders the empty state with no pressable when the preview text is empty', async () => {
    const renderer = await mountPreview(makePreview({ text: '', inlineText: '' }));

    expect(findByType(renderer.root, 'Pressable')).toHaveLength(0);
    const emptyTexts = findByType(renderer.root, 'Text').filter(
      node => node.props.children === 'This file is empty.'
    );
    expect(emptyTexts).toHaveLength(1);
  });
});
