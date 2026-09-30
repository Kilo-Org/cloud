import '@/i18n';
import { type FilePart, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
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
vi.mock('@/components/ui/icons', () => ({ AlertCircle: 'AlertCircle', ImageOff: 'ImageOff' }));
vi.mock('@/components/image-viewer-modal', () => ({ ImageViewerModal: 'ImageViewerModal' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));

function makeAttachment(id: string, mime: string, url: string, filename?: string): FilePart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime,
    url,
    ...(filename === undefined ? {} : { filename }),
  };
}

function makeToolPart(input: Record<string, unknown>, attachments: FilePart[]): ToolPart {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'read',
    state: {
      status: 'completed',
      input,
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

async function mountLabel(part: ToolPart): Promise<string | undefined> {
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
  // The label is exposed as the preview's accessibility label, so asserting it
  // here exercises the component's own resolution rather than a copy of it.
  const preview = renderer.root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      typeof node.props.accessibilityLabel === 'string'
  );
  const label = preview.props.accessibilityLabel as string;
  await act(async () => {
    await Promise.resolve();
    renderer.unmount();
  });
  return label;
}

describe('ToolCardImageAttachments label', () => {
  it('prefers the attachment filename over the tool input filePath', async () => {
    await act(async () => {
      await Promise.resolve();
      seedImageCache();
    });
    const part = makeToolPart(
      { filePath: '/workspace/screenshot.png' },
      [makeAttachment('att-1', 'image/png', '', 'photo.jpg')]
    );

    expect(await mountLabel(part)).toBe('Open photo.jpg full screen');
  });

  it('falls back to the input filePath basename when no attachment filename', async () => {
    await act(async () => {
      await Promise.resolve();
      seedImageCache();
    });
    const part = makeToolPart({ filePath: '/workspace/screenshot.png' }, [
      makeAttachment('att-1', 'image/png', ''),
    ]);

    expect(await mountLabel(part)).toBe('Open screenshot.png full screen');
  });

  it('falls back to the tool name when both are missing', async () => {
    await act(async () => {
      await Promise.resolve();
      seedImageCache();
    });
    const part = makeToolPart({}, [makeAttachment('att-1', 'image/png', '')]);

    expect(await mountLabel(part)).toBe('Open read full screen');
  });

  it('ignores a non-string filePath', async () => {
    await act(async () => {
      await Promise.resolve();
      seedImageCache();
    });
    const part = makeToolPart({ filePath: { nested: true } }, [
      makeAttachment('att-1', 'image/png', ''),
    ]);

    expect(await mountLabel(part)).toBe('Open read full screen');
  });
});
