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
        node.props.accessibilityLabel === 'Load x'
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
