import '@/i18n';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMarkdownImageConfirmMemory } from './markdown-image-confirm';
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
// bridge on import; stub that chain so the mounted render does not pull it in.
vi.mock('expo-secure-store', () => secureStoreMock);
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({ AlertCircle: 'AlertCircle', Download: 'Download' }));
vi.mock('@/components/ui/image-viewer', () => ({ ImageViewer: 'ImageViewer' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));

beforeEach(() => {
  clearMarkdownImageConfirmMemory();
});

function viewerCount(root: TestRenderer.ReactTestInstance): number {
  return root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'ImageViewer'
  ).length;
}

function imageCount(root: TestRenderer.ReactTestInstance): number {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === 'Image')
    .length;
}

const HTTP_CHIP_LINE =
  '\u2068A chart\u2069 · \u2068insecure.com\u2069 · \u2068HTTPS images only\u2069';
const HTTP_CHIP_LINE_WITHOUT_ALT = '\u2068insecure.com\u2069 · \u2068HTTPS images only\u2069';

async function mountImage(props: {
  uri: string;
  alt?: string;
  accessibilityLabel?: string;
  onPress?: () => void;
}): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(MarkdownImage, { alt: '', ...props }));
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

/** Names of the chips that answer the enclosing link's press. */
function linkChipLabels(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityRole === 'link'
    )
    .map(node => node.props.accessibilityLabel as string);
}

function textContents(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node => {
      const children = node.props.children;
      return Array.isArray(children) ? children.join('') : String(children ?? '');
    });
}

describe('MarkdownImage viewer mounting', () => {
  it('mounts ImageViewer only after the image is confirmed and pressed', async () => {
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
        node.props.accessibilityLabel === 'shot and Load x'
    );
    await act(async () => {
      await Promise.resolve();
      (loadButton.props.onPress as () => void)();
    });
    // The first press only opens the native trust dialog; choosing Load once
    // is what confirms the URI and mounts the Image.
    const buttons = alertMock.mock.calls.at(-1)?.[2] as
      | { text: string; onPress?: () => void }[]
      | undefined;
    const loadOnce = buttons?.find(button => button.text === 'Load once');
    if (!loadOnce?.onPress) {
      throw new Error('Load once action not found');
    }
    await act(async () => {
      await Promise.resolve();
      loadOnce.onPress?.();
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

/**
 * A blocked chip is the link's control, so its accessible name carries the
 * link's own name — but only when that name is not already drawn: an untitled
 * image link is named after its alt text (or, with no alt, after the href
 * host), which the drawn line already says.
 */
describe('BlockedImageChip link naming', () => {
  it('does not repeat an alt-text link name the chip already draws', async () => {
    const renderer = await mountImage({
      uri: 'http://insecure.com/a.png',
      alt: 'A chart',
      accessibilityLabel: 'A chart',
      onPress: () => undefined,
    });

    expect(linkChipLabels(renderer.root)).toEqual([HTTP_CHIP_LINE]);
    expect(textContents(renderer.root)).toContain(HTTP_CHIP_LINE);

    await unmount(renderer);
  });

  it('does not repeat a host link name the chip already draws', async () => {
    const renderer = await mountImage({
      uri: 'http://insecure.com/a.png',
      alt: '',
      accessibilityLabel: 'insecure.com',
      onPress: () => undefined,
    });

    expect(linkChipLabels(renderer.root)).toEqual([HTTP_CHIP_LINE_WITHOUT_ALT]);
    expect(textContents(renderer.root)).toContain(HTTP_CHIP_LINE_WITHOUT_ALT);

    await unmount(renderer);
  });

  it('merges a link name that the chip does not draw', async () => {
    const renderer = await mountImage({
      uri: 'http://insecure.com/a.png',
      alt: 'A chart',
      accessibilityLabel: 'Example site',
      onPress: () => undefined,
    });

    expect(linkChipLabels(renderer.root)).toEqual([`${HTTP_CHIP_LINE} and Example site`]);
    expect(textContents(renderer.root)).toContain(HTTP_CHIP_LINE);

    await unmount(renderer);
  });
});

/**
 * The unconfirmed row draws the image's description next to the Load control,
 * so the row's copy must leave the accessibility tree: the Load control is the
 * one that names the image, or a reader hears the description twice.
 */
describe('UnconfirmedImageChip row naming', () => {
  it('hides the drawn row copy and names the image on the Load control', async () => {
    const renderer = await mountImage({ uri: 'https://example.com/a.png', alt: 'A chart' });
    const drawn = '\u2068A chart\u2069 · \u2068example.com\u2069';

    const rowText = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.children === drawn
    );
    expect(rowText.props.accessibilityElementsHidden).toBe(true);
    expect(rowText.props.importantForAccessibility).toBe('no-hide-descendants');

    const row = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessible === false
    );
    expect(row.props.accessibilityLabel).toBeUndefined();

    const loadButtons = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityRole === 'button'
    );
    expect(loadButtons.map(node => node.props.accessibilityLabel)).toEqual([
      'A chart and Load example.com',
    ]);

    await unmount(renderer);
  });
});
