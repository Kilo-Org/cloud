/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/markdown-renderer.test.ts) */
import '@/i18n';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMarkdownImageConfirmMemory, confirmMarkdownImage } from './markdown-image-confirm';
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

beforeEach(() => {
  clearMarkdownImageConfirmMemory();
});

function ofType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function texts(root: TestRenderer.ReactTestInstance): string[] {
  return ofType(root, 'Text').map(node => {
    const children = node.props.children;
    if (Array.isArray(children)) {
      return children.join('');
    }
    return String(children ?? '');
  });
}

function findLoadButtons(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === 'Load'
  );
}

async function mount(uri: string, alt = ''): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(MarkdownImage, { uri, alt }));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function unmount(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.unmount();
  });
}

describe('MarkdownImage inert-until-load', () => {
  it('stays inert for HTTPS until Load, then mounts the Image', async () => {
    const renderer = await mount('https://example.com/a.png');
    expect(ofType(renderer.root, 'Image')).toHaveLength(0);

    const loadButtons = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Load'
    );
    expect(loadButtons).toHaveLength(1);
    const loadButton = loadButtons[0];
    if (!loadButton) {
      throw new Error('load button not found');
    }
    await act(async () => {
      await Promise.resolve();
      (loadButton.props.onPress as () => void)();
    });
    expect(ofType(renderer.root, 'Image')).toHaveLength(1);

    await unmount(renderer);
  });

  it('remembers a confirmed HTTPS URI across remounts', async () => {
    const first = await mount('https://example.com/a.png');
    const loadButtons = first.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Load'
    );
    const loadButton = loadButtons[0];
    if (!loadButton) {
      throw new Error('load button not found');
    }
    await act(async () => {
      await Promise.resolve();
      (loadButton.props.onPress as () => void)();
    });
    await unmount(first);

    const second = await mount('https://example.com/a.png');
    expect(ofType(second.root, 'Image')).toHaveLength(1);
    expect(
      second.root.findAll(
        node =>
          typeof node.type === 'string' &&
          (node.type as string) === 'Pressable' &&
          node.props.accessibilityLabel === 'Load'
      )
    ).toHaveLength(0);
    await unmount(second);
  });

  it('renders http and data URIs as static chips without fetching', async () => {
    const httpRenderer = await mount('http://insecure.com/a.png');
    expect(ofType(httpRenderer.root, 'Image')).toHaveLength(0);
    expect(ofType(httpRenderer.root, 'Pressable')).toHaveLength(0);
    expect(texts(httpRenderer.root)).toContain('insecure.com · HTTPS images only');
    await unmount(httpRenderer);

    const dataRenderer = await mount('data:image/png;base64,abc');
    expect(ofType(dataRenderer.root, 'Image')).toHaveLength(0);
    expect(ofType(dataRenderer.root, 'Pressable')).toHaveLength(0);
    expect(texts(dataRenderer.root)).toContain('HTTPS images only');
    await unmount(dataRenderer);
  });

  it('keeps the retry chip after a confirmed HTTPS image fails', async () => {
    confirmMarkdownImage('https://example.com/a.png');
    const renderer = await mount('https://example.com/a.png', 'shot');
    expect(ofType(renderer.root, 'Image')).toHaveLength(1);

    const image = ofType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });
    expect(ofType(renderer.root, 'Image')).toHaveLength(0);
    expect(texts(renderer.root)).toContain('Image unavailable shot');

    const retryButtons = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Image unavailable, retry loading'
    );
    expect(retryButtons).toHaveLength(1);
    const retryButton = retryButtons[0];
    if (!retryButton) {
      throw new Error('retry button not found');
    }
    await act(async () => {
      await Promise.resolve();
      (retryButton.props.onPress as () => void)();
    });
    expect(ofType(renderer.root, 'Image')).toHaveLength(1);

    await unmount(renderer);
  });

  it('renders alt text for an empty src', async () => {
    const renderer = await mount('', 'photo');
    expect(ofType(renderer.root, 'Image')).toHaveLength(0);
    expect(texts(renderer.root)).toContain('photo');
    await unmount(renderer);
  });

  it('re-derives confirmation from the current uri when the instance is recycled', async () => {
    // Start with an unconfirmed HTTPS URI: Load chip, no Image.
    const renderer = await mount('https://example.com/a.png');
    expect(ofType(renderer.root, 'Image')).toHaveLength(0);

    // Confirm a.png through the Load chip.
    const firstLoad = findLoadButtons(renderer.root)[0];
    if (!firstLoad) {
      throw new Error('load button not found');
    }
    await act(async () => {
      await Promise.resolve();
      (firstLoad.props.onPress as () => void)();
    });
    expect(ofType(renderer.root, 'Image')).toHaveLength(1);

    // Recycle the same instance to an unconfirmed URI: a stale `confirmed`
    // true would have mounted Image for b.png.
    await act(async () => {
      await Promise.resolve();
      renderer.update(createElement(MarkdownImage, { uri: 'https://example.com/b.png', alt: '' }));
    });
    expect(ofType(renderer.root, 'Image')).toHaveLength(0);
    expect(findLoadButtons(renderer.root)).toHaveLength(1);

    // Recycle back to a URI confirmed earlier in the session: it mounts the
    // Image with no Load chip, and b.png never inherited any consent.
    await act(async () => {
      await Promise.resolve();
      renderer.update(createElement(MarkdownImage, { uri: 'https://example.com/a.png', alt: '' }));
    });
    expect(ofType(renderer.root, 'Image')).toHaveLength(1);
    expect(findLoadButtons(renderer.root)).toHaveLength(0);

    await unmount(renderer);
  });
});
