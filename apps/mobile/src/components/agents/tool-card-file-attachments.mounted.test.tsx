/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { type FilePart, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { toast } from 'sonner-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getShareRemoteFileReason,
  shareLocalFile,
  ShareRemoteFileError,
} from '@/lib/share-remote-file';

import { ToolCardFileAttachments } from './tool-card-file-attachments';
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
  shareLocalFile: vi.fn(async () => {
    await Promise.resolve();
  }),
  getShareRemoteFileReason: vi.fn(() => null),
  ShareRemoteFileError: class ShareRemoteFileErrorMock extends Error {},
  getSafeCacheFilename: ({ id, filename }: { id: string; filename: string }) =>
    `${id}-${filename.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}`,
}));

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/icons', () => ({ FileIcon: 'FileIcon', Share2: 'Share2' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

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

const reportPdf: FilePart = {
  ...makeAttachment('att-1', 'application/pdf', ''),
  filename: 'report.pdf',
};
const notesTxt: FilePart = {
  ...makeAttachment('att-2', 'text/plain', ''),
  filename: 'notes.txt',
};

function makeToolPart(tool: string, attachments: FilePart[]): ToolPart {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state: {
      status: 'completed',
      input: { filePath: '/repo' },
      output: 'ok',
      title: tool,
      metadata: {},
      time: { start: 0, end: 1 },
      attachments,
    },
  };
}

function seedFileCache(): void {
  cacheToolAttachment('part-1', {
    mime: 'application/pdf',
    dataUrl: 'data:application/pdf;base64,QUJD',
    filename: 'report.pdf',
  });
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
    rendererRef.current = TestRenderer.create(createElement(ToolCardFileAttachments, { part }));
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

function shareButtons(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === 'Share report.pdf'
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

async function pressShare(root: TestRenderer.ReactTestInstance): Promise<void> {
  const button = shareButtons(root)[0];
  if (!button) {
    throw new Error('share button not found');
  }
  await act(async () => {
    await Promise.resolve();
    (button.props.onPress as () => void)();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ToolCardFileAttachments mounted', () => {
  it('renders one chip for the first of two attachments and shares it once', async () => {
    await act(async () => {
      await Promise.resolve();
      seedFileCache();
    });
    const renderer = await mount(makeToolPart('send_file', [reportPdf, notesTxt]));
    const root = renderer.root;

    expect(texts(root).filter(text => text === 'report.pdf')).toHaveLength(1);
    expect(texts(root)).not.toContain('notes.txt');
    expect(shareButtons(root)).toHaveLength(1);

    await pressShare(root);

    expect(shareLocalFile).toHaveBeenCalledTimes(1);
    expect(shareLocalFile).toHaveBeenCalledWith(
      'file:///cache/tool-card-images/part-1-report.pdf',
      {
        mimeType: 'application/pdf',
      }
    );

    await unmount(renderer);
  });

  it('shows one unavailable row and no share action when the cache is empty', async () => {
    const renderer = await mount(makeToolPart('send_file', [reportPdf, notesTxt]));
    const root = renderer.root;

    expect(shareButtons(root)).toHaveLength(0);
    expect(texts(root).filter(text => text === 'File unavailable in this session.')).toHaveLength(
      1
    );

    await unmount(renderer);
  });

  it('renders nothing for a read part with a non-image attachment', async () => {
    const renderer = await mount(makeToolPart('read', [reportPdf]));

    expect(renderer.toJSON()).toBeNull();

    await unmount(renderer);
  });

  it('flips the unavailable row to a chip when the cache write lands after mount', async () => {
    const renderer = await mount(makeToolPart('send_file', [reportPdf]));
    const root = renderer.root;

    expect(texts(root)).toContain('File unavailable in this session.');

    await act(async () => {
      await Promise.resolve();
      seedFileCache();
    });

    expect(texts(root)).not.toContain('File unavailable in this session.');
    expect(texts(root)).toContain('report.pdf');
    expect(shareButtons(root)).toHaveLength(1);

    await unmount(renderer);
  });

  it('toasts the typed share failure', async () => {
    await act(async () => {
      await Promise.resolve();
      seedFileCache();
    });
    const renderer = await mount(makeToolPart('send_file', [reportPdf]));
    const root = renderer.root;

    vi.mocked(shareLocalFile).mockRejectedValueOnce(new ShareRemoteFileError('download-failed'));

    await pressShare(root);

    expect(toast.error).toHaveBeenCalledWith('Failed to share file. Please try again.');

    await unmount(renderer);
  });

  it('toasts when sharing is unavailable on the device', async () => {
    await act(async () => {
      await Promise.resolve();
      seedFileCache();
    });
    const renderer = await mount(makeToolPart('send_file', [reportPdf]));
    const root = renderer.root;

    vi.mocked(shareLocalFile).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(getShareRemoteFileReason).mockReturnValueOnce('sharing-unavailable');

    await pressShare(root);

    expect(toast.error).toHaveBeenCalledWith('File sharing is not available on this device.');

    await unmount(renderer);
  });

  it('toasts a generic share failure', async () => {
    await act(async () => {
      await Promise.resolve();
      seedFileCache();
    });
    const renderer = await mount(makeToolPart('send_file', [reportPdf]));
    const root = renderer.root;

    vi.mocked(shareLocalFile).mockRejectedValueOnce(new Error('boom'));

    await pressShare(root);

    expect(toast.error).toHaveBeenCalledWith('Share failed');

    await unmount(renderer);
  });
});
