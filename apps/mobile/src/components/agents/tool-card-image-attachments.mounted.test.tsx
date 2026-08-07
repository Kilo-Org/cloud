/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { type FilePart, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolCardImageAttachments } from './tool-card-image-attachments';
import { __resetToolCardImageCacheForTests, cacheToolAttachment } from './tool-card-image-cache';

type FileInstance = {
  exists: boolean;
  uri: string;
  write: ReturnType<typeof vi.fn>;
  filename: string;
};

const fileInstances: FileInstance[] = [];

const expoFileSystemMock = vi.hoisted(() => {
  const directoryCreate = vi.fn();
  const Directory = vi.fn(function DirectoryMock(_base: unknown, name: string) {
    return {
      name,
      create: directoryCreate,
    };
  });
  const File = vi.fn(function FileMock(directory: { name?: string }, filename: string) {
    const instance = {
      exists: false,
      uri: `file:///cache/tool-card-images/${filename}`,
      write: vi.fn(),
      filename,
      directory,
    };
    fileInstances.push(instance);
    return instance;
  });
  return {
    Directory,
    File,
    Paths: { cache: 'file:///cache' },
    directoryCreate,
  };
});

vi.mock('expo-file-system', () => ({
  Directory: expoFileSystemMock.Directory,
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

vi.mock('@/lib/share-remote-file', () => ({
  getSafeCacheFilename: ({ id, filename }: { id: string; filename: string }) =>
    `${id}-${filename.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}`,
}));

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('lucide-react-native', () => ({ AlertCircle: 'AlertCircle', ImageOff: 'ImageOff' }));
vi.mock('@/components/image-viewer-modal', () => ({ ImageViewerModal: 'ImageViewerModal' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));

function makeAttachment(id: string, mime: string, url: string): FilePart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime,
    url,
  };
}

function makeToolPart(attachments: FilePart[]): ToolPart {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: '/repo/shot.png' },
      output: 'Image read successfully',
      title: 'read',
      metadata: {},
      time: { start: 0, end: 1 },
      attachments,
    },
  };
}

function seedImageCache(): void {
  cacheToolAttachment('part-1', { mime: 'image/png', dataUrl: 'data:image/png;base64,QUJD' });
}

beforeEach(() => {
  vi.clearAllMocks();
  fileInstances.length = 0;
  __resetToolCardImageCacheForTests();
});

async function mount(part: ToolPart): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(ToolCardImageAttachments, { part }));
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

function previewButtons(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === 'Open shot.png full screen'
  );
}

function viewers(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'ImageViewerModal'
  );
}

function texts(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node => {
      const children = node.props.children;
      if (Array.isArray(children)) {
        return children.join('');
      }
      return String(children ?? '');
    });
}

describe('ToolCardImageAttachments mounted', () => {
  it('renders one preview for a two-attachment part and mounts the viewer lazily', async () => {
    await act(async () => {
      await Promise.resolve();
      seedImageCache();
    });
    const part = makeToolPart([
      makeAttachment('att-1', 'image/png', ''),
      makeAttachment('att-2', 'image/jpeg', ''),
    ]);
    const renderer = await mount(part);
    const root = renderer.root;

    expect(previewButtons(root)).toHaveLength(1);
    expect(viewers(root)).toHaveLength(0);

    const preview = previewButtons(root)[0];
    if (!preview) {
      throw new Error('preview button not found');
    }
    await act(async () => {
      await Promise.resolve();
      (preview.props.onPress as () => void)();
    });
    expect(viewers(root)).toHaveLength(1);
    expect(viewers(root)[0]?.props).toMatchObject({
      visible: true,
      uri: 'file:///cache/tool-card-images/part-1.png',
    });

    await unmount(renderer);
  });

  it('shows one unavailable row and no preview when the cache is empty', async () => {
    const part = makeToolPart([
      makeAttachment('att-1', 'image/png', ''),
      makeAttachment('att-2', 'image/jpeg', ''),
    ]);
    const renderer = await mount(part);
    const root = renderer.root;

    expect(previewButtons(root)).toHaveLength(0);
    expect(viewers(root)).toHaveLength(0);
    expect(
      texts(root).filter(text => text === 'Image preview unavailable in this session.')
    ).toHaveLength(1);

    await unmount(renderer);
  });

  it('renders nothing when the part has no image attachments', async () => {
    const renderer = await mount(makeToolPart([]));

    expect(renderer.toJSON()).toBeNull();

    await unmount(renderer);
  });

  it('shows the decode-failure row after the image reports an error', async () => {
    await act(async () => {
      await Promise.resolve();
      seedImageCache();
    });
    const renderer = await mount(makeToolPart([makeAttachment('att-1', 'image/png', '')]));
    const root = renderer.root;

    expect(previewButtons(root)).toHaveLength(1);

    const image = root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'Image'
    );
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });

    expect(previewButtons(root)).toHaveLength(0);
    expect(texts(root)).toContain('Image unavailable');

    await unmount(renderer);
  });

  it('flips the unavailable row to a preview when the cache write lands after mount', async () => {
    const renderer = await mount(makeToolPart([makeAttachment('att-1', 'image/png', '')]));
    const root = renderer.root;

    expect(previewButtons(root)).toHaveLength(0);
    expect(texts(root)).toContain('Image preview unavailable in this session.');

    await act(async () => {
      await Promise.resolve();
      seedImageCache();
    });

    expect(previewButtons(root)).toHaveLength(1);
    expect(previewButtons(root)[0]?.props.accessibilityLabel).toBe('Open shot.png full screen');
    expect(texts(root)).not.toContain('Image preview unavailable in this session.');

    await unmount(renderer);
  });
});
