/* oxlint-disable max-lines -- cohesive suite: inert-until-load, viewer routing, and chip/link a11y share one tree-walk harness */
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

function slotCount(root: TestRenderer.ReactTestInstance, aspectRatio: number): number {
  return root.findAll(
    node => (node.props.style as { aspectRatio?: number } | undefined)?.aspectRatio === aspectRatio
  ).length;
}

function loadLabel(uri: string): string {
  return `Load ${new URL(uri).hostname.toLowerCase()}`;
}

function findLoadButtons(
  root: TestRenderer.ReactTestInstance,
  uri: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === loadLabel(uri)
  );
}

async function mount(
  uri: string,
  alt = '',
  options: {
    accessibilityLabel?: string;
    aspectRatio?: number;
    onPress?: () => void;
    onShowLinkActions?: () => void;
  } = {}
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      createElement(MarkdownImage, { uri, alt, ...options })
    );
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

    const loadButtons = findLoadButtons(renderer.root, 'https://example.com/a.png');
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
    const loadButtons = findLoadButtons(first.root, 'https://example.com/a.png');
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
    expect(findLoadButtons(second.root, 'https://example.com/a.png')).toHaveLength(0);
    await unmount(second);
  });

  it('renders http and data URIs as static chips without fetching', async () => {
    const httpRenderer = await mount('http://insecure.com/a.png');
    expect(ofType(httpRenderer.root, 'Image')).toHaveLength(0);
    expect(ofType(httpRenderer.root, 'Pressable')).toHaveLength(0);
    expect(texts(httpRenderer.root)).toContain('insecure.com · HTTPS images only');
    expect(slotCount(httpRenderer.root, 4 / 3)).toBe(1);
    await unmount(httpRenderer);

    const dataRenderer = await mount('data:image/png;base64,abc');
    expect(ofType(dataRenderer.root, 'Image')).toHaveLength(0);
    expect(ofType(dataRenderer.root, 'Pressable')).toHaveLength(0);
    expect(texts(dataRenderer.root)).toContain('HTTPS images only');
    expect(slotCount(dataRenderer.root, 4 / 3)).toBe(1);
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

  it('keeps the fallback ratio through consent, load, failure, retry, refresh, and remount', async () => {
    const uri = 'https://example.com/a.png';
    let renderer = await mount(uri, 'shot');

    expect(slotCount(renderer.root, 4 / 3)).toBe(1);
    const loadButton = findLoadButtons(renderer.root, 'https://example.com/a.png')[0];
    if (!loadButton) {
      throw new Error('load button not found');
    }
    await act(async () => {
      await Promise.resolve();
      (loadButton.props.onPress as () => void)();
    });
    expect(slotCount(renderer.root, 4 / 3)).toBe(1);
    expect(ofType(renderer.root, 'Skeleton')).toHaveLength(1);

    let image = ofType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onLoad as (event: unknown) => void)({
        source: { width: 100, height: 400 },
      });
    });
    expect(slotCount(renderer.root, 4 / 3)).toBe(1);
    expect(ofType(renderer.root, 'Skeleton')).toHaveLength(0);
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });
    expect(slotCount(renderer.root, 4 / 3)).toBe(1);

    const retry = renderer.root.find(
      node => node.props.accessibilityLabel === 'Image unavailable, retry loading'
    );
    await act(async () => {
      await Promise.resolve();
      (retry.props.onPress as () => void)();
    });
    expect(slotCount(renderer.root, 4 / 3)).toBe(1);
    expect(ofType(renderer.root, 'Skeleton')).toHaveLength(1);

    image = ofType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('image not found after retry');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onLoad as (event: unknown) => void)({
        source: { width: 100, height: 400 },
      });
      renderer.update(createElement(MarkdownImage, { uri, alt: 'shot' }));
    });
    expect(slotCount(renderer.root, 4 / 3)).toBe(1);

    await unmount(renderer);
    renderer = await mount(uri, 'shot');
    expect(slotCount(renderer.root, 4 / 3)).toBe(1);
    await unmount(renderer);
  });

  it('keeps an explicit HTML image ratio', async () => {
    const renderer = await mount('https://example.com/a.png', 'shot', { aspectRatio: 2 });
    expect(slotCount(renderer.root, 2)).toBe(1);
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
    const firstLoad = findLoadButtons(renderer.root, 'https://example.com/a.png')[0];
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
    expect(findLoadButtons(renderer.root, 'https://example.com/b.png')).toHaveLength(1);

    // Recycle back to a URI confirmed earlier in the session: it mounts the
    // Image with no Load chip, and b.png never inherited any consent.
    await act(async () => {
      await Promise.resolve();
      renderer.update(createElement(MarkdownImage, { uri: 'https://example.com/a.png', alt: '' }));
    });
    expect(ofType(renderer.root, 'Image')).toHaveLength(1);
    expect(findLoadButtons(renderer.root, 'https://example.com/a.png')).toHaveLength(0);

    await unmount(renderer);
  });

  it('resets failed state when recycled to a new URI after a fail', async () => {
    confirmMarkdownImage('https://example.com/a.png');
    const renderer = await mount('https://example.com/a.png', 'shot');
    const image = ofType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });
    // Old URI shows the retry chip.
    expect(texts(renderer.root)).toContain('Image unavailable shot');

    // Recycle to a new, unconfirmed URI: it must show Load, never the old chip.
    await act(async () => {
      await Promise.resolve();
      renderer.update(createElement(MarkdownImage, { uri: 'https://example.com/b.png', alt: '' }));
    });
    expect(texts(renderer.root)).not.toContain('Image unavailable shot');
    expect(ofType(renderer.root, 'Image')).toHaveLength(0);
    expect(findLoadButtons(renderer.root, 'https://example.com/b.png')).toHaveLength(1);

    await unmount(renderer);
  });

  it('dismisses the viewer when recycled to a new URI', async () => {
    confirmMarkdownImage('https://example.com/a.png');
    const renderer = await mount('https://example.com/a.png', 'shot');
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
    expect(ofType(renderer.root, 'ImageViewerModal')).toHaveLength(1);

    await act(async () => {
      await Promise.resolve();
      renderer.update(createElement(MarkdownImage, { uri: 'https://example.com/b.png', alt: '' }));
    });
    expect(ofType(renderer.root, 'ImageViewerModal')).toHaveLength(0);

    await unmount(renderer);
  });

  it('exposes showLinkActions on the Load chip and routes it to the callback', async () => {
    const onShow = vi.fn<() => void>();
    const renderer = await mount('https://example.com/a.png', '', {
      onShowLinkActions: onShow,
    });
    const load = findLoadButtons(renderer.root, 'https://example.com/a.png')[0];
    if (!load) {
      throw new Error('load button not found');
    }
    expect(load.props.accessibilityActions).toEqual([
      { name: 'showLinkActions', label: 'Show link actions' },
    ]);
    await act(async () => {
      await Promise.resolve();
      (load.props.onAccessibilityAction as (event: unknown) => void)({
        nativeEvent: { actionName: 'showLinkActions' },
      });
    });
    expect(onShow).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('omits showLinkActions when no callback is provided', async () => {
    const renderer = await mount('https://example.com/a.png');
    const load = findLoadButtons(renderer.root, 'https://example.com/a.png')[0];
    if (!load) {
      throw new Error('load button not found');
    }
    expect(load.props.accessibilityActions).toBeUndefined();

    await unmount(renderer);
  });

  it('exposes showLinkActions on the blocked chip when a callback is supplied', async () => {
    const onShow = vi.fn<() => void>();
    const renderer = await mount('http://insecure.com/a.png', '', {
      onShowLinkActions: onShow,
    });
    const chip = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        node.props.accessibilityLabel === 'insecure.com · HTTPS images only'
    );
    expect(chip.props.accessibilityActions).toEqual([
      { name: 'showLinkActions', label: 'Show link actions' },
    ]);
    await act(async () => {
      await Promise.resolve();
      (chip.props.onAccessibilityAction as (event: unknown) => void)({
        nativeEvent: { actionName: 'showLinkActions' },
      });
    });
    expect(onShow).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('exposes showLinkActions on the retry chip when a callback is supplied', async () => {
    confirmMarkdownImage('https://example.com/a.png');
    const onShow = vi.fn<() => void>();
    const renderer = await mount('https://example.com/a.png', 'shot', {
      onShowLinkActions: onShow,
    });

    const image = ofType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });

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
    expect(retryButton.props.accessibilityActions).toEqual([
      { name: 'showLinkActions', label: 'Show link actions' },
    ]);
    await act(async () => {
      await Promise.resolve();
      (retryButton.props.onAccessibilityAction as (event: unknown) => void)({
        nativeEvent: { actionName: 'showLinkActions' },
      });
    });
    expect(onShow).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('keeps the viewer as the default action after load and carries showLinkActions', async () => {
    confirmMarkdownImage('https://example.com/a.png');
    const onShow = vi.fn<() => void>();
    const renderer = await mount('https://example.com/a.png', 'shot', {
      onShowLinkActions: onShow,
    });
    const imageButton = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'View image shot'
    );
    expect(imageButton.props.accessibilityActions).toEqual([
      { name: 'showLinkActions', label: 'Show link actions' },
    ]);
    // Default action still opens the viewer, not a browser.
    await act(async () => {
      await Promise.resolve();
      (imageButton.props.onPress as () => void)();
    });
    expect(ofType(renderer.root, 'ImageViewerModal')).toHaveLength(1);

    await unmount(renderer);
  });

  it('uses the linked destination as the loaded image action and label', async () => {
    confirmMarkdownImage('https://example.com/a.png');
    const onPress = vi.fn<() => void>();
    const renderer = await mount('https://example.com/a.png', 'shot', {
      accessibilityLabel: 'Example',
      onPress,
    });
    const imageLink = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Example'
    );
    expect(imageLink.props.accessibilityRole).toBe('link');

    await act(async () => {
      await Promise.resolve();
      (imageLink.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(ofType(renderer.root, 'ImageViewerModal')).toHaveLength(0);

    await unmount(renderer);
  });

  it('Load control is at least 44pt and announces host plus action', async () => {
    const renderer = await mount('https://example.com/a.png');
    const load = findLoadButtons(renderer.root, 'https://example.com/a.png')[0];
    if (!load) {
      throw new Error('load button not found');
    }
    expect(load.props.className).toContain('min-h-11');
    expect(load.props.className).toContain('min-w-11');
    expect(load.props.accessibilityLabel).toBe('Load example.com');

    await unmount(renderer);
  });
});
