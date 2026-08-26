/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import '@/i18n';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMarkdownImageConfirmMemory } from './markdown-image-confirm';
import { clearMarkdownImageSrcMemory, MEDIA_SOURCE_HEADER } from './markdown-image-src';
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
const tokenState = vi.hoisted(() => {
  const state: { current: { token: string; expiresAtMs: null } | null } = {
    current: { token: 'test-token', expiresAtMs: null },
  };
  return state;
});
vi.mock('@/lib/auth/token-owner', () => ({
  getActiveToken: () => tokenState.current,
}));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
}));

beforeEach(() => {
  clearMarkdownImageConfirmMemory();
  clearMarkdownImageSrcMemory();
  tokenState.current = { token: 'test-token', expiresAtMs: null };
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
        node.props.accessibilityLabel === 'Load x'
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
  it('loads a confirmed image through the media proxy with auth and source headers', async () => {
    const uri = 'https://cdn.example.com/a.png?signature=secret';
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(createElement(MarkdownImage, { uri, alt: 'shot' }));
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const loadButton = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Load cdn.example.com'
    );
    await act(async () => {
      await Promise.resolve();
      (loadButton.props.onPress as () => void)();
    });

    const image = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'Image'
    );
    const source = image.props.source as { uri: string; headers: Record<string, string> };
    expect(source.uri).toBe('https://api.test/api/media/proxy?id=m0');
    expect(source.uri).not.toContain('secret');
    expect(source.headers.Authorization).toBe('Bearer test-token');
    expect(source.headers[MEDIA_SOURCE_HEADER]).toBe(uri);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('shows the loading placeholder instead of a retry chip while no token is held', async () => {
    tokenState.current = null;
    const uri = 'https://cdn.example.com/a.png';
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(createElement(MarkdownImage, { uri, alt: 'shot' }));
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const loadButton = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Load cdn.example.com'
    );
    await act(async () => {
      await Promise.resolve();
      (loadButton.props.onPress as () => void)();
    });

    // No unauthenticated request, and no retry affordance that cannot help.
    expect(imageCount(renderer.root)).toBe(0);
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          (node.type as string) === 'Pressable' &&
          node.props.accessibilityLabel === 'Image unavailable, retry loading'
      )
    ).toHaveLength(0);
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Skeleton'
      ).length
    ).toBeGreaterThan(0);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });
});
