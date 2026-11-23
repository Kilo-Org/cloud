/* oxlint-disable max-lines -- cohesive suite: inert-until-load, viewer routing, and chip/link a11y share one tree-walk harness */
import '@/i18n';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TOUCH_TARGET_CLASS } from '@/lib/a11y/tap-target';
import {
  clearTrustedImageHosts,
  revokeImageHost,
  trustImageHost,
} from '@/lib/hooks/use-trusted-image-hosts';

import { clearMarkdownImageConfirmMemory, confirmMarkdownImage } from './markdown-image-confirm';
import { MarkdownImage } from './markdown-image';

const alertMock = vi.hoisted(() => vi.fn());
const secureStoreMock = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('react-native', () => ({
  Alert: { alert: alertMock },
  Pressable: 'Pressable',
  View: 'View',
}));
// The trusted-image-host store reaches SecureStore, Sentry and the toast
// bridge on import; stub that chain so this suite exercises the confirm memory
// rather than the preference's disk read.
vi.mock('expo-secure-store', () => secureStoreMock);
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Download: 'Download',
  RotateCcw: 'RotateCcw',
}));
vi.mock('@/components/ui/image-viewer', () => ({ ImageViewer: 'ImageViewer' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111', mutedForeground: '#666666' }),
}));

beforeEach(() => {
  clearMarkdownImageConfirmMemory();
  clearTrustedImageHosts();
  alertMock.mockClear();
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

function loadLabel(uri: string, alt = ''): string {
  const withHost = `Load ${new URL(uri).hostname.toLowerCase()}`;
  return alt ? `${alt} and ${withHost}` : withHost;
}

function findLoadButtons(
  root: TestRenderer.ReactTestInstance,
  uri: string,
  alt = ''
): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === loadLabel(uri, alt)
  );
}

/**
 * Press the Load chip and answer the native trust dialog. The first press only
 * opens the dialog; the chosen action is what confirms or trusts, so a test
 * that expects an Image must go through here rather than the chip's onPress.
 */
function chooseAlertAction(action: string): void {
  const buttons = alertMock.mock.calls.at(-1)?.[2] as
    | { text: string; onPress?: () => void }[]
    | undefined;
  const button = buttons?.find(candidate => candidate.text === action);
  if (!button?.onPress) {
    throw new Error(`alert action "${action}" not found`);
  }
  button.onPress();
}

async function pressLoad(
  root: TestRenderer.ReactTestInstance,
  uri: string,
  { action = 'Load once', alt = '' }: { action?: string; alt?: string } = {}
): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    const loadButton = findLoadButtons(root, uri, alt)[0];
    if (!loadButton) {
      throw new Error('load button not found');
    }
    (loadButton.props.onPress as () => void)();
    chooseAlertAction(action);
  });
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
    expect(texts(renderer.root)).toContain('Load');

    const loadButtons = findLoadButtons(renderer.root, 'https://example.com/a.png');
    expect(loadButtons).toHaveLength(1);
    await pressLoad(renderer.root, 'https://example.com/a.png');
    expect(ofType(renderer.root, 'Image')).toHaveLength(1);
    expect(ofType(renderer.root, 'Image')[0]?.props.recyclingKey).toBe('https://example.com/a.png');

    await unmount(renderer);
  });

  it('asks before loading an untrusted HTTPS image and stays inert until answered', async () => {
    const uri = 'https://example.com/a.png';
    const renderer = await mount(uri);
    const loadButton = findLoadButtons(renderer.root, uri)[0];
    if (!loadButton) {
      throw new Error('load button not found');
    }
    await act(async () => {
      await Promise.resolve();
      (loadButton.props.onPress as () => void)();
    });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls.at(-1)?.[0]).toBe('Load image from example.com?');
    expect(ofType(renderer.root, 'Image')).toHaveLength(0);

    await act(() => {
      chooseAlertAction('Load once');
    });
    expect(ofType(renderer.root, 'Image')).toHaveLength(1);
    await unmount(renderer);
  });

  it('remembers a confirmed HTTPS URI across remounts', async () => {
    const first = await mount('https://example.com/a.png');
    await pressLoad(first.root, 'https://example.com/a.png');
    await unmount(first);

    const second = await mount('https://example.com/a.png');
    expect(ofType(second.root, 'Image')).toHaveLength(1);
    expect(findLoadButtons(second.root, 'https://example.com/a.png')).toHaveLength(0);
    await unmount(second);
  });

  it('loads every mounted slot for a confirmed HTTPS URI', async () => {
    const uri = 'https://example.com/a.png';
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(
          'View',
          null,
          createElement(MarkdownImage, { uri, alt: 'first' }),
          createElement(MarkdownImage, { uri, alt: 'second' })
        )
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    await pressLoad(renderer.root, uri, { alt: 'first' });

    expect(ofType(renderer.root, 'Image')).toHaveLength(2);
    await unmount(renderer);
  });

  it('renders http and data URIs as static chips without fetching', async () => {
    const httpRenderer = await mount('http://insecure.com/a.png');
    expect(ofType(httpRenderer.root, 'Image')).toHaveLength(0);
    // Nothing to press without a link: the chip is plain content, never a button.
    expect(ofType(httpRenderer.root, 'Pressable')).toHaveLength(0);
    expect(texts(httpRenderer.root)).toContain(
      '\u2068insecure.com\u2069 · \u2068HTTPS images only\u2069'
    );
    expect(slotCount(httpRenderer.root, 4 / 3)).toBe(0);
    await unmount(httpRenderer);

    const dataRenderer = await mount('data:image/png;base64,abc');
    expect(ofType(dataRenderer.root, 'Image')).toHaveLength(0);
    expect(ofType(dataRenderer.root, 'Pressable')).toHaveLength(0);
    expect(texts(dataRenderer.root)).toContain('\u2068HTTPS images only\u2069');
    expect(slotCount(dataRenderer.root, 4 / 3)).toBe(0);
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
    expect(texts(renderer.root)).toContain('Image unavailable\nshot');
    expect(texts(renderer.root)).toContain('Retry');

    const retryButtons = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Image unavailable, shot, and Retry'
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

  it.each([
    { dimensions: { width: 800, height: 1000 }, expectedRatio: 0.8, shape: 'portrait' },
    { dimensions: { width: 2500, height: 1000 }, expectedRatio: 2.5, shape: 'panorama' },
  ])(
    'uses the intrinsic ratio for a plain Markdown $shape image',
    async ({ dimensions, expectedRatio }) => {
      const uri = `https://example.com/${dimensions.width}x${dimensions.height}.png`;
      confirmMarkdownImage(uri);
      const renderer = await mount(uri, 'shot');
      const image = ofType(renderer.root, 'Image')[0];
      if (!image) {
        throw new Error('image not found');
      }

      await act(async () => {
        await Promise.resolve();
        (image.props.onLoad as (event: unknown) => void)({ source: dimensions });
      });

      expect(slotCount(renderer.root, expectedRatio)).toBe(1);
      await unmount(renderer);
    }
  );

  it('keeps the measured ratio through failure, retry, and refresh', async () => {
    const uri = 'https://example.com/a.png';
    let renderer = await mount(uri, 'shot');

    expect(slotCount(renderer.root, 4 / 3)).toBe(1);
    await pressLoad(renderer.root, uri, { alt: 'shot' });
    expect(slotCount(renderer.root, 4 / 3)).toBe(1);
    expect(ofType(renderer.root, 'Skeleton')).toHaveLength(1);

    const image = ofType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onLoad as (event: unknown) => void)({
        source: { width: 100, height: 400 },
      });
    });
    expect(slotCount(renderer.root, 0.75)).toBe(1);
    expect(ofType(renderer.root, 'Skeleton')).toHaveLength(0);
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });
    expect(slotCount(renderer.root, 0.75)).toBe(1);

    const retry = renderer.root.find(
      node => node.props.accessibilityLabel === 'Image unavailable, shot, and Retry'
    );
    await act(async () => {
      await Promise.resolve();
      (retry.props.onPress as () => void)();
    });
    expect(slotCount(renderer.root, 0.75)).toBe(1);
    expect(ofType(renderer.root, 'Skeleton')).toHaveLength(1);

    const retryImage = ofType(renderer.root, 'Image')[0];
    if (!retryImage) {
      throw new Error('image not found after retry');
    }
    await act(async () => {
      await Promise.resolve();
      (retryImage.props.onLoad as (event: unknown) => void)({
        source: { width: 100, height: 400 },
      });
      renderer.update(createElement(MarkdownImage, { uri, alt: 'shot' }));
    });
    expect(slotCount(renderer.root, 0.75)).toBe(1);

    await unmount(renderer);
    renderer = await mount(uri, 'shot');
    expect(slotCount(renderer.root, 4 / 3)).toBe(1);
    await unmount(renderer);
  });

  it('keeps an explicit HTML image ratio', async () => {
    const uri = 'https://example.com/html.png';
    confirmMarkdownImage(uri);
    const renderer = await mount(uri, 'shot', { aspectRatio: 2 });
    const image = ofType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }

    await act(async () => {
      await Promise.resolve();
      (image.props.onLoad as (event: unknown) => void)({
        source: { width: 100, height: 400 },
      });
    });

    expect(slotCount(renderer.root, 2)).toBe(1);
    expect(slotCount(renderer.root, 0.75)).toBe(0);
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
    await pressLoad(renderer.root, 'https://example.com/a.png');
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
    expect(texts(renderer.root)).toContain('Image unavailable\nshot');

    // Recycle to a new, unconfirmed URI: it must show Load, never the old chip.
    await act(async () => {
      await Promise.resolve();
      renderer.update(createElement(MarkdownImage, { uri: 'https://example.com/b.png', alt: '' }));
    });
    expect(texts(renderer.root)).not.toContain('Image unavailable\nshot');
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
    expect(ofType(renderer.root, 'ImageViewer')).toHaveLength(1);

    await act(async () => {
      await Promise.resolve();
      renderer.update(createElement(MarkdownImage, { uri: 'https://example.com/b.png', alt: '' }));
    });
    expect(ofType(renderer.root, 'ImageViewer')).toHaveLength(0);

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
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === '\u2068insecure.com\u2069 · \u2068HTTPS images only\u2069'
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
        node.props.accessibilityLabel === 'Image unavailable, shot, and Retry'
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
    expect(ofType(renderer.root, 'ImageViewer')).toHaveLength(1);

    await unmount(renderer);
  });

  it('keeps the image description when a confirmed linked image remounts', async () => {
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
        node.props.accessibilityLabel === 'View image shot and Example'
    );
    expect(imageLink.props.accessibilityRole).toBe('link');

    await act(async () => {
      await Promise.resolve();
      (imageLink.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(ofType(renderer.root, 'ImageViewer')).toHaveLength(0);

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

/**
 * The trusted-image-host preference, applied through the shared renderer both
 * the session and PR-review pages mount. Claim coverage:
 * - Trusting a host records its normalized key so a later image from the same
 *   host auto-loads with no per-URL prompt.
 * - Revoking the host removes that key and re-gates its images, so the next
 *   mount shows the Load chip instead of fetching.
 * - A trusted host never unlocks a non-HTTPS URI: http:// and data: stay
 *   blocked and never auto-load.
 */
describe('MarkdownImage trusted-host policy', () => {
  it('auto-loads a later image from a trusted host without another prompt', async () => {
    const first = await mount('https://example.com/a.png');
    await pressLoad(first.root, 'https://example.com/a.png', { action: 'Trust this host' });
    expect(ofType(first.root, 'Image')).toHaveLength(1);
    await unmount(first);

    const second = await mount('https://example.com/b.png');
    expect(ofType(second.root, 'Image')).toHaveLength(1);
    expect(findLoadButtons(second.root, 'https://example.com/b.png')).toHaveLength(0);
    await unmount(second);
  });

  it('re-gates a trusted host image after the host is revoked', async () => {
    trustImageHost('example.com');
    const renderer = await mount('https://example.com/a.png');
    expect(ofType(renderer.root, 'Image')).toHaveLength(1);

    await act(async () => {
      await Promise.resolve();
      revokeImageHost('example.com');
    });

    expect(ofType(renderer.root, 'Image')).toHaveLength(0);
    expect(findLoadButtons(renderer.root, 'https://example.com/a.png')).toHaveLength(1);
    await unmount(renderer);
  });

  it('never auto-loads http or data URIs from a trusted host', async () => {
    trustImageHost('insecure.com');
    const httpRenderer = await mount('http://insecure.com/a.png');
    expect(ofType(httpRenderer.root, 'Image')).toHaveLength(0);
    expect(ofType(httpRenderer.root, 'Pressable')).toHaveLength(0);
    await unmount(httpRenderer);

    const dataRenderer = await mount('data:image/png;base64,abc');
    expect(ofType(dataRenderer.root, 'Image')).toHaveLength(0);
    expect(ofType(dataRenderer.root, 'Pressable')).toHaveLength(0);
    await unmount(dataRenderer);
  });
});

/**
 * The chips stand in for an image the reader cannot see, so each one carries
 * the alt text the markdown gave it, and each one offers the message's link
 * actions on long press exactly as the loaded image does.
 */
describe('MarkdownImage chip descriptions and long press', () => {
  it('puts the alt text in front of an http chip reason', async () => {
    const renderer = await mount('http://insecure.com/a.png', 'A chart');
    expect(texts(renderer.root)).toContain(
      '\u2068A chart\u2069 · \u2068insecure.com\u2069 · \u2068HTTPS images only\u2069'
    );
    const chip = ofType(renderer.root, 'View')[0];
    if (!chip) {
      throw new Error('blocked chip not found');
    }
    expect(chip.props.accessibilityRole).toBe('text');
    expect(chip.props.accessibilityLabel).toBe(
      '\u2068A chart\u2069 · \u2068insecure.com\u2069 · \u2068HTTPS images only\u2069'
    );
    expect(ofType(renderer.root, 'Image')).toHaveLength(0);

    await unmount(renderer);
  });

  it('puts the alt text in front of a data URI chip reason', async () => {
    const renderer = await mount('data:image/png;base64,abc', 'A chart');
    expect(texts(renderer.root)).toContain('\u2068A chart\u2069 · \u2068HTTPS images only\u2069');
    expect(ofType(renderer.root, 'View')[0]?.props.accessibilityLabel).toBe(
      '\u2068A chart\u2069 · \u2068HTTPS images only\u2069'
    );
    expect(ofType(renderer.root, 'Image')).toHaveLength(0);

    await unmount(renderer);
  });

  it('follows the enclosing link when the blocked chip is tapped', async () => {
    const onPress = vi.fn<() => void>();
    const renderer = await mount('http://insecure.com/a.png', 'A chart', {
      accessibilityLabel: 'Example',
      onPress,
    });
    const chip = ofType(renderer.root, 'Pressable')[0];
    if (!chip) {
      throw new Error('blocked chip not found');
    }
    expect(chip.props.accessibilityRole).toBe('link');
    expect(String(chip.props.className)).toContain('active:opacity-80');

    await act(async () => {
      await Promise.resolve();
      (chip.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('keeps the blocked chip inert without a link or link actions', async () => {
    const renderer = await mount('http://insecure.com/a.png', 'A chart');
    // Nothing to press, nothing to grow: no pressable host at all.
    expect(ofType(renderer.root, 'Pressable')).toHaveLength(0);
    const chip = ofType(renderer.root, 'View')[0];
    if (!chip) {
      throw new Error('blocked chip not found');
    }
    expect(chip.props.accessibilityRole).toBe('text');
    expect(String(chip.props.className)).not.toContain(TOUCH_TARGET_CLASS);
    expect(String(chip.props.className)).not.toContain('active:opacity-80');

    await unmount(renderer);
  });

  it('sizes the blocked chip as a touch target once it answers a press', async () => {
    const renderer = await mount('http://insecure.com/a.png', 'A chart', {
      onShowLinkActions: () => undefined,
    });
    const chip = ofType(renderer.root, 'Pressable')[0];
    if (!chip) {
      throw new Error('blocked chip not found');
    }
    expect(chip.props.onLongPress).toBeTypeOf('function');
    expect(String(chip.props.className)).toContain(TOUCH_TARGET_CLASS);

    await unmount(renderer);
  });

  it('names the unconfirmed chip row and its Load button with the alt text', async () => {
    const uri = 'https://example.com/a.png';
    const renderer = await mount(uri, 'A chart');
    expect(texts(renderer.root)).toContain('\u2068A chart\u2069 · \u2068example.com\u2069');

    const load = findLoadButtons(renderer.root, uri, 'A chart')[0];
    if (!load) {
      throw new Error('load button not found');
    }
    expect(load.props.accessibilityLabel).toBe('A chart and Load example.com');

    await unmount(renderer);
  });

  it('long-presses the blocked chip into the link actions', async () => {
    const onShow = vi.fn<() => void>();
    const renderer = await mount('http://insecure.com/a.png', '', {
      onShowLinkActions: onShow,
    });
    const chip = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === '\u2068insecure.com\u2069 · \u2068HTTPS images only\u2069'
    );
    expect(chip.props.onLongPress).toBe(onShow);
    await act(async () => {
      await Promise.resolve();
      (chip.props.onLongPress as () => void)();
    });
    expect(onShow).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('long-presses the unconfirmed Load button into the link actions', async () => {
    const uri = 'https://example.com/a.png';
    const onShow = vi.fn<() => void>();
    const renderer = await mount(uri, '', { onShowLinkActions: onShow });
    const load = findLoadButtons(renderer.root, uri)[0];
    if (!load) {
      throw new Error('load button not found');
    }
    expect(load.props.onLongPress).toBe(onShow);
    await act(async () => {
      await Promise.resolve();
      (load.props.onLongPress as () => void)();
    });
    expect(onShow).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('retries a failed image on tap instead of following its link', async () => {
    const uri = 'https://example.com/a.png';
    confirmMarkdownImage(uri);
    const onPress = vi.fn<() => void>();
    const renderer = await mount(uri, 'shot', { accessibilityLabel: 'Example', onPress });
    const image = ofType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });

    const retry = ofType(renderer.root, 'Pressable')[0];
    if (!retry) {
      throw new Error('retry chip not found');
    }
    expect(texts(renderer.root)).toContain('Image unavailable\nshot');
    await act(async () => {
      await Promise.resolve();
      (retry.props.onPress as () => void)();
    });
    expect(onPress).not.toHaveBeenCalled();
    expect(ofType(renderer.root, 'Image')).toHaveLength(1);

    await unmount(renderer);
  });

  it('names the retry chip with the alt text and keeps the plain copy without it', async () => {
    const uri = 'https://example.com/a.png';
    confirmMarkdownImage(uri);
    const renderer = await mount(uri, 'shot');
    const image = ofType(renderer.root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });
    expect(ofType(renderer.root, 'Pressable')[0]?.props.accessibilityLabel).toBe(
      'Image unavailable, shot, and Retry'
    );
    await unmount(renderer);

    const plainUri = 'https://example.com/b.png';
    confirmMarkdownImage(plainUri);
    const plainRenderer = await mount(plainUri);
    const plainImage = ofType(plainRenderer.root, 'Image')[0];
    if (!plainImage) {
      throw new Error('image not found');
    }
    await act(async () => {
      await Promise.resolve();
      (plainImage.props.onError as () => void)();
    });
    expect(ofType(plainRenderer.root, 'Pressable')[0]?.props.accessibilityLabel).toBe(
      'Image unavailable, retry loading'
    );
    await unmount(plainRenderer);
  });

  it('falls back to the translated image name for an empty alt and src', async () => {
    const renderer = await mount('', '');
    expect(texts(renderer.root)).toContain('Image');
    await unmount(renderer);
  });

  it('names the viewer of an alt-less HTTPS image with the translated image name', async () => {
    const uri = 'https://example.com/';
    confirmMarkdownImage(uri);
    const renderer = await mount(uri, '');

    const imageButton = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'View image'
    );
    await act(async () => {
      await Promise.resolve();
      (imageButton.props.onPress as () => void)();
    });
    expect(ofType(renderer.root, 'ImageViewer')[0]?.props.filename).toBe('Image');

    await unmount(renderer);
  });
});
