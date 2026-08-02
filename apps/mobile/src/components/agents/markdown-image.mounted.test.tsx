/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Pressable: 'Pressable' }));
vi.mock('lucide-react-native', () => ({ AlertCircle: 'AlertCircle' }));
vi.mock('@/components/image-viewer-modal', () => ({ ImageViewerModal: 'ImageViewerModal' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));

import { MarkdownImage } from './markdown-image';

function viewerCount(root: TestRenderer.ReactTestInstance): number {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === 'ImageViewerModal').length;
}

describe('MarkdownImage viewer mounting', () => {
  it('mounts ImageViewerModal only after the image is pressed', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(MarkdownImage, { uri: 'https://x/a.png', alt: 'shot' })
      );
    });
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    expect(viewerCount(renderer.root)).toBe(0);

    const button = renderer.root.find(node => typeof node.type === 'string' && (node.type as string) === 'Pressable');
    await act(async () => {
      button.props.onPress();
    });
    expect(viewerCount(renderer.root)).toBe(1);

    await act(async () => {
      renderer?.unmount();
    });
  });
});
