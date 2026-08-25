/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import '@/i18n';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMarkdownImageConfirmMemory } from './markdown-image-confirm';
import { MarkdownImage } from './markdown-image';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/icons', () => ({ AlertCircle: 'AlertCircle', Download: 'Download' }));
vi.mock('@/components/image-viewer-modal', () => ({ ImageViewerModal: 'ImageViewerModal' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));
vi.mock('@/lib/auth/token-owner', () => ({
  getActiveToken: () => ({ token: 'test-token', expiresAtMs: null }),
}));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
}));

beforeEach(() => {
  clearMarkdownImageConfirmMemory();
});

function viewerCount(root: TestRenderer.ReactTestInstance): number {
  return root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'ImageViewerModal'
  ).length;
}

function imageCount(root: TestRenderer.ReactTestInstance): number {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === 'Image')
    .length;
}

describe('MarkdownImage viewer mounting', () => {
  it('mounts ImageViewerModal only after the image is confirmed and pressed', async () => {
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
    // The HTTPS image stays inert until Load: no Image and no viewer yet.
    expect(imageCount(renderer.root)).toBe(0);
    expect(viewerCount(renderer.root)).toBe(0);

    const loadButton = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Load'
    );
    await act(async () => {
      await Promise.resolve();
      (loadButton.props.onPress as () => void)();
    });
    expect(imageCount(renderer.root)).toBe(1);

    const imageButton = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'View image shot'
    );
    await act(async () => {
      await Promise.resolve();
      (imageButton.props.onPress as () => void)();
    });
    expect(viewerCount(renderer.root)).toBe(1);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });
});
