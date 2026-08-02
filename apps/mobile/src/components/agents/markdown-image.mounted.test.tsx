/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { MarkdownImage } from './markdown-image';

vi.mock('react-native', () => ({ Pressable: 'Pressable' }));
vi.mock('lucide-react-native', () => ({ AlertCircle: 'AlertCircle' }));
vi.mock('@/components/image-viewer-modal', () => ({ ImageViewerModal: 'ImageViewerModal' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));

function viewerCount(root: TestRenderer.ReactTestInstance): number {
  return root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'ImageViewerModal'
  ).length;
}

describe('MarkdownImage viewer mounting', () => {
  it('mounts ImageViewerModal only after the image is pressed', async () => {
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(MarkdownImage, { uri: 'https://x/a.png', alt: 'shot' })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    expect(viewerCount(renderer.root)).toBe(0);

    const button = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'Pressable'
    );
    await act(async () => {
      await Promise.resolve();
      (button.props.onPress as () => void)();
    });
    expect(viewerCount(renderer.root)).toBe(1);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });
});
