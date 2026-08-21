/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
/* eslint-disable max-lines -- cohesive mounted suite: all FilePart tap/preview/share states share one harness */
import { type FilePart } from '@kilocode/cloud-agent-sdk';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FilePartRenderer } from './file-part-renderer';
import {
  __resetFilePartCacheForTests,
  cacheFilePart,
  overwriteFilePartCacheEntry,
} from './file-part-cache';
import { __resetFilePartUrlResolverForTests } from './file-part-url-resolver';

type FileInstance = {
  uri: string;
  write: ReturnType<typeof vi.fn>;
  text: ReturnType<typeof vi.fn>;
  filename?: string;
};

const fileInstances: FileInstance[] = [];

const expoFileSystemMock = vi.hoisted(() => {
  const directoryCreate = vi.fn();
  const fileText = vi.fn();
  const Directory = vi.fn(function DirectoryMock(_base: unknown, name: string) {
    return {
      name,
      create: directoryCreate,
    };
  });
  const File = vi.fn(function FileMock(directoryOrUri: unknown, filename?: string) {
    const instance = {
      uri:
        typeof directoryOrUri === 'string'
          ? directoryOrUri
          : `file:///cache/session-file-parts/${filename}`,
      write: vi.fn(),
      text: fileText,
      filename,
    };
    fileInstances.push(instance);
    return instance;
  });
  return {
    Directory,
    File,
    Paths: { cache: 'file:///cache' },
    directoryCreate,
    fileText,
  };
});

vi.mock('expo-file-system', () => ({
  Directory: expoFileSystemMock.Directory,
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

const shareRemoteFileMock = vi.hoisted(() => ({
  downloadRemoteFile: vi.fn(),
  getSafeCacheFilename: vi.fn(),
  getShareRemoteFileReason: vi.fn(),
  shareLocalFile: vi.fn(),
  shareRemoteFile: vi.fn(),
}));

vi.mock('@/lib/share-remote-file', () => ({
  downloadRemoteFile: shareRemoteFileMock.downloadRemoteFile,
  getSafeCacheFilename: shareRemoteFileMock.getSafeCacheFilename,
  getShareRemoteFileReason: shareRemoteFileMock.getShareRemoteFileReason,
  ShareRemoteFileError: class ShareRemoteFileErrorMock extends Error {},
  shareLocalFile: shareRemoteFileMock.shareLocalFile,
  shareRemoteFile: shareRemoteFileMock.shareRemoteFile,
}));

const showActionSheetWithOptions = vi.hoisted(() => vi.fn());

vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions }),
}));

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('sonner-native', () => ({ toast: toastMock }));

const getAttachmentDownloadUrlMutate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: {
      getAttachmentDownloadUrl: { mutate: getAttachmentDownloadUrlMutate },
    },
  },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ AlertCircle: 'AlertCircle', File: 'File' }));
vi.mock('@/components/image-viewer-modal', () => ({ ImageViewerModal: 'ImageViewerModal' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));
vi.mock('./chat-markdown-text', () => ({ ChatMarkdownText: 'ChatMarkdownText' }));

function makeFilePart(input: {
  id: string;
  mime: string;
  filename?: string;
  url: string;
}): FilePart {
  return {
    id: input.id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime: input.mime,
    url: input.url,
    ...(input.filename ? { filename: input.filename } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fileInstances.length = 0;
  __resetFilePartCacheForTests();
  __resetFilePartUrlResolverForTests();
  getAttachmentDownloadUrlMutate.mockReset();
  getAttachmentDownloadUrlMutate.mockResolvedValue({
    signedUrl: 'https://r2.example/signed',
    key: 'k',
    expiresAt: '2026-01-01T00:00:00Z',
  });
  expoFileSystemMock.fileText.mockReset();
  shareRemoteFileMock.getSafeCacheFilename.mockImplementation(
    ({ id, filename }: { id: string; filename: string }) => `${id}-${filename}`
  );
  shareRemoteFileMock.getShareRemoteFileReason.mockReturnValue(null);
  shareRemoteFileMock.shareLocalFile.mockResolvedValue(undefined);
  shareRemoteFileMock.shareRemoteFile.mockResolvedValue(undefined);
  shareRemoteFileMock.downloadRemoteFile.mockImplementation(
    ({ cacheFilename }: { cacheFilename: string }) => ({
      uri: `file:///cache/session-file-parts/${cacheFilename}`,
      delete: vi.fn(),
    })
  );
});

async function mount(part: FilePart): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(FilePartRenderer, { part }));
  });
  const renderer = ref.current;
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

async function press(node: TestRenderer.ReactTestInstance): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    (node.props.onPress as () => void)();
  });
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function pressableByLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === label
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

function first(nodes: TestRenderer.ReactTestInstance[]): TestRenderer.ReactTestInstance {
  const node = nodes[0];
  if (!node) {
    throw new Error('expected node not found');
  }
  return node;
}

function actionSheetCallback(): (index?: number) => void {
  const call = showActionSheetWithOptions.mock.calls[0];
  if (!call) {
    throw new Error('action sheet was not shown');
  }
  return call[1] as (index?: number) => void;
}

async function selectActionSheet(index: number): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    actionSheetCallback()(index);
  });
}

describe('FilePartRenderer mounted', () => {
  it('opens the full-screen viewer when an image FilePart is tapped', async () => {
    cacheFilePart('part-1', { url: 'https://x/a.png', mime: 'image/png', filename: 'shot.png' });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'image/png', filename: 'shot.png', url: '' })
    );
    const root = renderer.root;

    const buttons = pressableByLabel(root, 'Open shot.png full screen');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props.accessibilityRole).toBe('button');
    expect(findByType(root, 'ImageViewerModal')).toHaveLength(0);

    await press(first(buttons));

    const viewers = findByType(root, 'ImageViewerModal');
    expect(viewers).toHaveLength(1);
    expect(viewers[0]?.props).toMatchObject({ visible: true, uri: 'https://x/a.png' });

    await unmount(renderer);
  });

  it('swaps the thumbnail to a retry row after the image reports an error', async () => {
    cacheFilePart('part-1', { url: 'https://x/a.png', mime: 'image/png', filename: 'shot.png' });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'image/png', filename: 'shot.png', url: '' })
    );
    const root = renderer.root;

    const image = findByType(root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });

    expect(pressableByLabel(root, 'Open shot.png full screen')).toHaveLength(0);
    expect(pressableByLabel(root, 'Image unavailable, retry loading')).toHaveLength(1);
    expect(texts(root)).toContain('Image unavailable');

    await unmount(renderer);
  });

  it('previews a markdown FilePart with the decoded text', async () => {
    expoFileSystemMock.fileText.mockResolvedValue('# Hello');
    cacheFilePart('part-1', {
      url: 'data:text/markdown;base64,QUJD',
      mime: 'text/markdown',
      filename: 'readme.md',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: 'readme.md', url: '' })
    );
    const root = renderer.root;

    const buttons = pressableByLabel(root, 'Preview readme.md');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props.accessibilityRole).toBe('button');

    await press(first(buttons));
    await flushAsync();

    const markdown = findByType(root, 'ChatMarkdownText');
    expect(markdown).toHaveLength(1);
    expect(markdown[0]?.props.value).toBe('# Hello');

    await unmount(renderer);
  });

  it('shows the ActionSheet when a non-image, non-markdown FilePart is tapped', async () => {
    cacheFilePart('part-1', {
      url: 'data:application/pdf;base64,QUJD',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'application/pdf', filename: 'report.pdf', url: '' })
    );
    const root = renderer.root;

    const buttons = pressableByLabel(root, 'Open report.pdf');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props.accessibilityRole).toBe('button');

    await press(first(buttons));

    expect(showActionSheetWithOptions).toHaveBeenCalledTimes(1);
    const options = showActionSheetWithOptions.mock.calls[0]?.[0] as {
      options: string[];
      cancelButtonIndex: number;
    };
    expect(options.options).toEqual(['Open as text', 'Open in external app', 'Cancel']);
    expect(options.cancelButtonIndex).toBe(2);

    await unmount(renderer);
  });

  it('opens the text modal for "Open as text"', async () => {
    expoFileSystemMock.fileText.mockResolvedValue('plain text body');
    cacheFilePart('part-1', {
      url: 'data:application/pdf;base64,QUJD',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'application/pdf', filename: 'report.pdf', url: '' })
    );
    const root = renderer.root;

    await press(first(pressableByLabel(root, 'Open report.pdf')));
    await selectActionSheet(0);
    await flushAsync();

    expect(texts(root)).toContain('plain text body');
    expect(findByType(root, 'ChatMarkdownText')).toHaveLength(0);

    await unmount(renderer);
  });

  it('shares a captured data: URL as a file:// URI via shareLocalFile for "Open in external app"', async () => {
    cacheFilePart('part-1', {
      url: 'data:application/pdf;base64,QUJD',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'application/pdf', filename: 'report.pdf', url: '' })
    );
    const root = renderer.root;

    await press(first(pressableByLabel(root, 'Open report.pdf')));
    await selectActionSheet(1);
    await flushAsync();

    expect(shareRemoteFileMock.shareLocalFile).toHaveBeenCalledTimes(1);
    expect(shareRemoteFileMock.shareLocalFile).toHaveBeenCalledWith(
      'file:///cache/session-file-parts/part-1-report.pdf',
      { mimeType: 'application/pdf' }
    );

    await unmount(renderer);
  });

  it('resolves a cached file:// URI (from a data: write) for text preview without re-downloading', async () => {
    expoFileSystemMock.fileText.mockResolvedValue('# Hello');
    cacheFilePart('part-1', {
      url: 'data:text/markdown;base64,QUJD',
      mime: 'text/markdown',
      filename: 'readme.md',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: 'readme.md', url: '' })
    );
    const root = renderer.root;

    await press(first(pressableByLabel(root, 'Preview readme.md')));
    await flushAsync();

    const markdown = findByType(root, 'ChatMarkdownText');
    expect(markdown).toHaveLength(1);
    expect(markdown[0]?.props.value).toBe('# Hello');
    expect(shareRemoteFileMock.downloadRemoteFile).not.toHaveBeenCalled();

    await unmount(renderer);
  });

  it('shares a cached file:// URI (from a data: write) via shareLocalFile without re-downloading', async () => {
    cacheFilePart('part-1', {
      url: 'data:application/pdf;base64,QUJD',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'application/pdf', filename: 'report.pdf', url: '' })
    );
    const root = renderer.root;

    await press(first(pressableByLabel(root, 'Open report.pdf')));
    await selectActionSheet(1);
    await flushAsync();

    expect(shareRemoteFileMock.shareLocalFile).toHaveBeenCalledTimes(1);
    expect(shareRemoteFileMock.shareLocalFile).toHaveBeenCalledWith(
      'file:///cache/session-file-parts/part-1-report.pdf',
      { mimeType: 'application/pdf' }
    );
    expect(shareRemoteFileMock.shareRemoteFile).not.toHaveBeenCalled();
    expect(shareRemoteFileMock.downloadRemoteFile).not.toHaveBeenCalled();

    await unmount(renderer);
  });

  it('shows an unavailable row for an uncached file:// part.url', async () => {
    const renderer = await mount(
      makeFilePart({
        id: 'part-1',
        mime: 'image/png',
        filename: 'shot.png',
        url: 'file:///etc/passwd',
      })
    );
    const root = renderer.root;

    expect(pressableByLabel(root, 'Open shot.png full screen')).toHaveLength(0);
    expect(texts(root)).toContain('Image unavailable');

    await unmount(renderer);
  });

  it('toasts "Preview unavailable" for an uncached file:// part.url chip', async () => {
    const renderer = await mount(
      makeFilePart({
        id: 'part-1',
        mime: 'application/pdf',
        filename: 'report.pdf',
        url: 'file:///etc/passwd',
      })
    );
    const root = renderer.root;

    await press(first(pressableByLabel(root, 'Open report.pdf')));

    expect(toastMock.error).toHaveBeenCalledWith('Preview unavailable');
    expect(showActionSheetWithOptions).not.toHaveBeenCalled();

    await unmount(renderer);
  });

  it('shares an http(s) URL via shareRemoteFile for "Open in external app"', async () => {
    cacheFilePart('part-1', {
      url: 'https://x/report.pdf',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'application/pdf', filename: 'report.pdf', url: '' })
    );
    const root = renderer.root;

    await press(first(pressableByLabel(root, 'Open report.pdf')));
    await selectActionSheet(1);
    await flushAsync();

    expect(shareRemoteFileMock.shareRemoteFile).toHaveBeenCalledTimes(1);
    expect(shareRemoteFileMock.shareRemoteFile).toHaveBeenCalledWith({
      url: 'https://x/report.pdf',
      cacheDirectoryName: 'session-file-parts',
      cacheKey: 'part-1',
      filename: 'report.pdf',
    });

    await unmount(renderer);
  });

  it('shows a loading indicator while the markdown text resolves', async () => {
    expoFileSystemMock.fileText.mockReturnValue(new Promise<string>(() => undefined));
    cacheFilePart('part-1', {
      url: 'data:text/markdown;base64,QUJD',
      mime: 'text/markdown',
      filename: 'readme.md',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: 'readme.md', url: '' })
    );
    const root = renderer.root;

    await press(first(pressableByLabel(root, 'Preview readme.md')));

    expect(findByType(root, 'ActivityIndicator')).toHaveLength(1);

    await unmount(renderer);
  });

  it('shows "This file is empty." for empty decoded text', async () => {
    expoFileSystemMock.fileText.mockResolvedValue('');
    cacheFilePart('part-1', {
      url: 'data:text/markdown;base64,QUJD',
      mime: 'text/markdown',
      filename: 'readme.md',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: 'readme.md', url: '' })
    );
    const root = renderer.root;

    await press(first(pressableByLabel(root, 'Preview readme.md')));
    await flushAsync();

    expect(texts(root)).toContain('This file is empty.');

    await unmount(renderer);
  });

  it('shows an error and retry when the text fails to load', async () => {
    expoFileSystemMock.fileText.mockRejectedValue(new Error('boom'));
    cacheFilePart('part-1', {
      url: 'data:text/markdown;base64,QUJD',
      mime: 'text/markdown',
      filename: 'readme.md',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: 'readme.md', url: '' })
    );
    const root = renderer.root;

    await press(first(pressableByLabel(root, 'Preview readme.md')));
    await flushAsync();

    expect(texts(root)).toContain('Could not load this file.');
    expect(pressableByLabel(root, 'Retry loading file')).toHaveLength(1);

    await unmount(renderer);
  });

  it('shows an unavailable row for an image with no usable URL', async () => {
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'image/png', filename: 'shot.png', url: '' })
    );
    const root = renderer.root;

    expect(pressableByLabel(root, 'Open shot.png full screen')).toHaveLength(0);
    expect(texts(root)).toContain('Image unavailable');

    await unmount(renderer);
  });

  it('toasts "Preview unavailable" when a chip has no usable URL', async () => {
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'application/pdf', filename: 'report.pdf', url: '' })
    );
    const root = renderer.root;

    const buttons = pressableByLabel(root, 'Open report.pdf');
    expect(buttons).toHaveLength(1);

    await press(first(buttons));

    expect(toastMock.error).toHaveBeenCalledWith('Preview unavailable');
    expect(showActionSheetWithOptions).not.toHaveBeenCalled();
    expect(findByType(root, 'Modal')).toHaveLength(0);

    await unmount(renderer);
  });

  it('toasts when sharing is unavailable on the device', async () => {
    cacheFilePart('part-1', {
      url: 'data:application/pdf;base64,QUJD',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'application/pdf', filename: 'report.pdf', url: '' })
    );
    const root = renderer.root;

    shareRemoteFileMock.shareLocalFile.mockRejectedValueOnce(new Error('boom'));
    shareRemoteFileMock.getShareRemoteFileReason.mockReturnValueOnce('sharing-unavailable');

    await press(first(pressableByLabel(root, 'Open report.pdf')));
    await selectActionSheet(1);
    await flushAsync();

    expect(toastMock.error).toHaveBeenCalledWith('File sharing is not available on this device.');

    await unmount(renderer);
  });

  it('presigns a markdown attachment and previews its text', async () => {
    expoFileSystemMock.fileText.mockResolvedValue('# Attachment');
    const uuid = '11111111-1111-4111-8111-111111111111';
    cacheFilePart('part-1', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.md`,
      mime: 'text/markdown',
      filename: `${uuid}.md`,
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: `${uuid}.md`, url: '' })
    );
    const root = renderer.root;

    await flushAsync();

    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledWith({
      messageUuid: uuid,
      filename: `${uuid}.md`,
    });

    await press(first(pressableByLabel(root, `Preview ${uuid}.md`)));
    await flushAsync();

    const markdown = findByType(root, 'ChatMarkdownText');
    expect(markdown).toHaveLength(1);
    expect(markdown[0]?.props.value).toBe('# Attachment');
    expect(toastMock.error).not.toHaveBeenCalledWith('Preview unavailable');

    await unmount(renderer);
  });

  it('opens the markdown modal after a tap during the presign resolves', async () => {
    expoFileSystemMock.fileText.mockResolvedValue('# Attachment');
    const uuid = '33333333-3333-4333-8333-333333333333';
    cacheFilePart('part-1', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.md`,
      mime: 'text/markdown',
      filename: `${uuid}.md`,
    });
    const presignHolder: {
      resolve?: (value: { signedUrl: string; key: string; expiresAt: string }) => void;
    } = {};
    getAttachmentDownloadUrlMutate.mockReturnValueOnce(
      new Promise(resolve => {
        presignHolder.resolve = resolve;
      })
    );

    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: `${uuid}.md`, url: '' })
    );
    const root = renderer.root;

    // The presign is still in flight, so the chip is busy. A tap during that
    // window must open the modal once the URL lands, without a second tap.
    await press(first(pressableByLabel(root, `Preview ${uuid}.md`)));
    expect(findByType(root, 'Modal')).toHaveLength(0);

    await act(async () => {
      presignHolder.resolve?.({
        signedUrl: 'https://r2.example/signed',
        key: 'k',
        expiresAt: '2026-01-01T00:00:00Z',
      });
      await Promise.resolve();
    });
    await flushAsync();

    const markdown = findByType(root, 'ChatMarkdownText');
    expect(markdown).toHaveLength(1);
    expect(markdown[0]?.props.value).toBe('# Attachment');

    await unmount(renderer);
  });

  it('shows a retry toast when the presign fails, then opens after a successful retry', async () => {
    expoFileSystemMock.fileText.mockResolvedValue('# Attachment');
    const uuid = '22222222-2222-4222-8222-222222222222';
    cacheFilePart('part-1', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.md`,
      mime: 'text/markdown',
      filename: `${uuid}.md`,
    });
    getAttachmentDownloadUrlMutate.mockRejectedValueOnce(new Error('presign failed'));

    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: `${uuid}.md`, url: '' })
    );
    const root = renderer.root;

    await flushAsync();

    await press(first(pressableByLabel(root, `Preview ${uuid}.md`)));

    expect(toastMock.error).toHaveBeenCalledWith('Could not load this file. Try again.');
    expect(findByType(root, 'Modal')).toHaveLength(0);

    await flushAsync();

    await press(first(pressableByLabel(root, `Preview ${uuid}.md`)));
    await flushAsync();

    const markdown = findByType(root, 'ChatMarkdownText');
    expect(markdown).toHaveLength(1);
    expect(markdown[0]?.props.value).toBe('# Attachment');

    await unmount(renderer);
  });

  it('presigns an image attachment and renders the inline image', async () => {
    const uuid = '33333333-3333-4333-8333-333333333333';
    cacheFilePart('part-1', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.png`,
      mime: 'image/png',
      filename: `${uuid}.png`,
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'image/png', filename: `${uuid}.png`, url: '' })
    );
    const root = renderer.root;

    await flushAsync();

    const image = findByType(root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    expect(image.props.source).toEqual({ uri: 'https://r2.example/signed' });

    await press(first(pressableByLabel(root, `Open ${uuid}.png full screen`)));

    const viewers = findByType(root, 'ImageViewerModal');
    expect(viewers).toHaveLength(1);
    expect(viewers[0]?.props).toMatchObject({ visible: true, uri: 'https://r2.example/signed' });

    await unmount(renderer);
  });

  it('reuses the cached presigned URL after an unmount and remount', async () => {
    expoFileSystemMock.fileText.mockResolvedValue('# Attachment');
    const uuid = '77777777-7777-4777-8777-777777777777';
    cacheFilePart('part-1', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.md`,
      mime: 'text/markdown',
      filename: `${uuid}.md`,
    });

    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: `${uuid}.md`, url: '' })
    );
    await flushAsync();

    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(1);

    await unmount(renderer);

    const remounted = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: `${uuid}.md`, url: '' })
    );
    await flushAsync();

    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(1);

    await press(first(pressableByLabel(remounted.root, `Preview ${uuid}.md`)));
    await flushAsync();

    const markdown = findByType(remounted.root, 'ChatMarkdownText');
    expect(markdown).toHaveLength(1);
    expect(markdown[0]?.props.value).toBe('# Attachment');

    await unmount(remounted);
  });

  it('retries the presign after an image presign failure', async () => {
    const uuid = '88888888-8888-4888-8888-888888888888';
    cacheFilePart('part-1', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.png`,
      mime: 'image/png',
      filename: `${uuid}.png`,
    });
    getAttachmentDownloadUrlMutate.mockRejectedValueOnce(new Error('presign failed'));

    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'image/png', filename: `${uuid}.png`, url: '' })
    );
    const root = renderer.root;

    await flushAsync();

    expect(pressableByLabel(root, 'Image unavailable, retry loading')).toHaveLength(1);
    expect(texts(root)).toContain('Image unavailable');

    await press(first(pressableByLabel(root, 'Image unavailable, retry loading')));
    await flushAsync();

    const image = findByType(root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    expect(image.props.source).toEqual({ uri: 'https://r2.example/signed' });

    await unmount(renderer);
  });

  it('toasts "Preview unavailable" for a part with no URL and no cache entry', async () => {
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'application/pdf', filename: 'report.pdf', url: '' })
    );
    const root = renderer.root;

    await flushAsync();

    await press(first(pressableByLabel(root, 'Open report.pdf')));

    expect(toastMock.error).toHaveBeenCalledWith('Preview unavailable');
    expect(getAttachmentDownloadUrlMutate).not.toHaveBeenCalled();

    await unmount(renderer);
  });

  it('re-presigns on modal Retry after a download failure', async () => {
    expoFileSystemMock.fileText.mockResolvedValue('# Attachment');
    const uuid = '44444444-4444-4444-8444-444444444444';
    cacheFilePart('part-1', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.md`,
      mime: 'text/markdown',
      filename: `${uuid}.md`,
    });
    shareRemoteFileMock.downloadRemoteFile.mockRejectedValueOnce(new Error('R2 404'));

    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: `${uuid}.md`, url: '' })
    );
    const root = renderer.root;

    await flushAsync();

    await press(first(pressableByLabel(root, `Preview ${uuid}.md`)));
    await flushAsync();

    expect(texts(root)).toContain('Could not load this file.');
    const retryButtons = pressableByLabel(root, 'Retry loading file');
    expect(retryButtons).toHaveLength(1);

    const callsBefore = getAttachmentDownloadUrlMutate.mock.calls.length;
    await press(first(retryButtons));
    await flushAsync();

    expect(getAttachmentDownloadUrlMutate.mock.calls.length).toBe(callsBefore + 1);

    const markdown = findByType(root, 'ChatMarkdownText');
    expect(markdown).toHaveLength(1);
    expect(markdown[0]?.props.value).toBe('# Attachment');

    await unmount(renderer);
  });

  it('shows "This file is empty." for an empty markdown attachment', async () => {
    expoFileSystemMock.fileText.mockResolvedValue('');
    const uuid = '55555555-5555-4555-8555-555555555555';
    cacheFilePart('part-1', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.md`,
      mime: 'text/markdown',
      filename: `${uuid}.md`,
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: `${uuid}.md`, url: '' })
    );
    const root = renderer.root;

    await flushAsync();

    await press(first(pressableByLabel(root, `Preview ${uuid}.md`)));
    await flushAsync();

    expect(texts(root)).toContain('This file is empty.');

    await unmount(renderer);
  });

  it('re-presigns on image retry when the cache entry carries an attachment ref', async () => {
    const uuid = '99999999-9999-4999-8999-999999999999';
    cacheFilePart('part-1', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.png`,
      mime: 'image/png',
      filename: `${uuid}.png`,
    });
    overwriteFilePartCacheEntry('part-1', {
      url: 'https://r2.example/signed',
      mime: 'image/png',
      filename: `${uuid}.png`,
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'image/png', filename: `${uuid}.png`, url: '' })
    );
    const root = renderer.root;

    const image = findByType(root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });

    expect(pressableByLabel(root, 'Image unavailable, retry loading')).toHaveLength(1);

    const callsBefore = getAttachmentDownloadUrlMutate.mock.calls.length;
    await press(first(pressableByLabel(root, 'Image unavailable, retry loading')));
    await flushAsync();

    expect(getAttachmentDownloadUrlMutate.mock.calls.length).toBe(callsBefore + 1);
    expect(pressableByLabel(root, 'Image unavailable, retry loading')).toHaveLength(0);
    const reRendered = findByType(root, 'Image')[0];
    expect(reRendered?.props.source).toEqual({ uri: 'https://r2.example/signed' });

    await unmount(renderer);
  });

  it('re-renders the same URL on image retry when there is no attachment ref', async () => {
    cacheFilePart('part-1', {
      url: 'data:image/png;base64,QUJD',
      mime: 'image/png',
      filename: 'shot.png',
    });
    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'image/png', filename: 'shot.png', url: '' })
    );
    const root = renderer.root;

    const image = findByType(root, 'Image')[0];
    if (!image) {
      throw new Error('image not found');
    }
    expect(image.props.source).toEqual({ uri: 'file:///cache/session-file-parts/part-1-shot.png' });

    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });

    expect(pressableByLabel(root, 'Image unavailable, retry loading')).toHaveLength(1);

    await press(first(pressableByLabel(root, 'Image unavailable, retry loading')));
    await flushAsync();

    expect(getAttachmentDownloadUrlMutate).not.toHaveBeenCalled();
    expect(pressableByLabel(root, 'Image unavailable, retry loading')).toHaveLength(0);
    const reRendered = findByType(root, 'Image')[0];
    expect(reRendered?.props.source).toEqual({
      uri: 'file:///cache/session-file-parts/part-1-shot.png',
    });

    await unmount(renderer);
  });

  it('toasts when a markdown tap during the presign is followed by a presign failure', async () => {
    const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    cacheFilePart('part-1', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.md`,
      mime: 'text/markdown',
      filename: `${uuid}.md`,
    });
    const presignHolder: { reject?: (error: Error) => void } = {};
    getAttachmentDownloadUrlMutate.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        presignHolder.reject = reject;
      })
    );

    const renderer = await mount(
      makeFilePart({ id: 'part-1', mime: 'text/markdown', filename: `${uuid}.md`, url: '' })
    );
    const root = renderer.root;

    await press(first(pressableByLabel(root, `Preview ${uuid}.md`)));
    expect(findByType(root, 'Modal')).toHaveLength(0);

    await act(async () => {
      presignHolder.reject?.(new Error('presign failed'));
      await Promise.resolve();
    });
    await flushAsync();

    expect(toastMock.error).toHaveBeenCalledWith('Could not load this file. Try again.');
    expect(findByType(root, 'Modal')).toHaveLength(0);

    await unmount(renderer);
  });
});
