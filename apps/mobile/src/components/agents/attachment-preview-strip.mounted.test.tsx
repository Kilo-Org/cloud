/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/markdown-image.mounted.test.tsx) */
/* eslint-disable max-lines -- cohesive mounted suite: chip a11y contract and tappable-open paths share one strip harness */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { toast } from 'sonner-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getShareRemoteFileReason,
  shareLocalFile,
  ShareRemoteFileError,
} from '@/lib/share-remote-file';

import { type AgentAttachment } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { AttachmentPreviewStrip } from './attachment-preview-strip';

const expoFileSystemMock = vi.hoisted(() => {
  const fileText = vi.fn(async () => {
    await Promise.resolve();
    return '# Hello';
  });
  const File = vi.fn(function FileMock(_uri: string) {
    return { text: fileText };
  });
  return { fileText, File };
});

const actionSheetMock = vi.hoisted(() => {
  const showActionSheetWithOptions = vi.fn();
  return { showActionSheetWithOptions };
});

const reactNativeMock = vi.hoisted(() => ({
  Platform: { OS: 'ios' as string },
  useWindowDimensions: vi.fn(() => ({ width: 390, height: 844 })),
}));
const safeAreaMock = vi.hoisted(() => ({
  useSafeAreaInsets: vi.fn(() => ({ top: 0, bottom: 0 })),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  Platform: reactNativeMock.Platform,
  useWindowDimensions: reactNativeMock.useWindowDimensions,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: safeAreaMock.useSafeAreaInsets,
}));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  File: 'File',
  RotateCcw: 'RotateCcw',
  X: 'X',
}));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    destructive: '#b91c1c',
    foreground: '#111827',
    mutedForeground: '#6b7280',
  }),
}));
vi.mock('@/components/image-viewer-modal', () => ({ ImageViewerModal: 'ImageViewerModal' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/agents/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
vi.mock('@/components/ui/selectable-text', () => ({ SelectableText: 'SelectableText' }));
vi.mock('expo-file-system', () => ({
  File: expoFileSystemMock.File,
}));
vi.mock('@/lib/share-remote-file', () => ({
  shareLocalFile: vi.fn(async () => {
    await Promise.resolve();
  }),
  getShareRemoteFileReason: vi.fn(() => null),
  ShareRemoteFileError: class ShareRemoteFileErrorMock extends Error {},
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({
    showActionSheetWithOptions: actionSheetMock.showActionSheetWithOptions,
  }),
}));

const { fileText } = expoFileSystemMock;
const { showActionSheetWithOptions } = actionSheetMock;

function makeAttachment(overrides: Partial<AgentAttachment>): AgentAttachment {
  return {
    id: 'a1',
    filename: 'doc.pdf',
    kind: 'document',
    extension: 'pdf',
    mimeType: 'application/pdf',
    size: 1024,
    localUri: 'file:///cache/doc.pdf',
    status: 'uploaded',
    progress: 1,
    remoteFilename: 'org/2026/07/uuid/doc.pdf',
    ...overrides,
  };
}

type Renderer = TestRenderer.ReactTestRenderer;

async function mount(
  attachments: AgentAttachment[],
  handlers: { onRemove?: () => void; onRetry?: () => void } = {}
): Promise<Renderer> {
  const ref: { current: Renderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(AttachmentPreviewStrip, {
        attachments,
        onRemove: handlers.onRemove ?? (() => undefined),
        onRetry: handlers.onRetry ?? (() => undefined),
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** The single accessible chip body — `find` throws when a chip is absent. */
function chipBody(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      ((node.type as string) === 'View' || (node.type as string) === 'Pressable') &&
      node.props.accessible === true
  );
}

/** The hidden wrapper that isolates the chip body's visual descendants. */
function chipContentWrapper(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      node.props.importantForAccessibility === 'no-hide-descendants'
  );
}

function labeledPressables(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      typeof node.props.accessibilityLabel === 'string'
  );
}

function pressableByLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance | undefined {
  return labeledPressables(root).find(node => node.props.accessibilityLabel === label);
}

function nodesByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function findByTestID(
  root: TestRenderer.ReactTestInstance,
  testID: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.props.testID === testID);
}

async function pressBody(root: TestRenderer.ReactTestInstance): Promise<void> {
  const body = chipBody(root);
  await act(async () => {
    await Promise.resolve();
    (body.props.onPress as () => void)();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function latestSheetHandler(): (index: number) => void {
  const calls = vi.mocked(showActionSheetWithOptions).mock.calls;
  const last = calls.at(-1);
  const handler = last?.[1];
  if (typeof handler !== 'function') {
    throw new TypeError('action sheet handler missing');
  }
  return handler;
}

async function chooseSheetOption(
  root: TestRenderer.ReactTestInstance,
  index: number
): Promise<void> {
  await pressBody(root);
  const handler = latestSheetHandler();
  await act(async () => {
    await Promise.resolve();
    handler(index);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function markdownAttachment(): AgentAttachment {
  return makeAttachment({
    filename: 'notes.md',
    kind: 'document',
    extension: 'md',
    mimeType: 'text/plain',
    localUri: 'file:///cache/notes.md',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fileText.mockResolvedValue('# Hello');
  reactNativeMock.Platform.OS = 'ios';
  reactNativeMock.useWindowDimensions.mockReturnValue({ width: 390, height: 844 });
  safeAreaMock.useSafeAreaInsets.mockReturnValue({ top: 0, bottom: 0 });
});

describe('AttachmentPreviewStrip — mounted accessibility contract', () => {
  it('exposes determinate progress value on a button while uploading', async () => {
    const renderer = await mount([makeAttachment({ status: 'uploading', progress: 0.42 })]);

    const body = chipBody(renderer.root);
    expect(body.props.accessibilityRole).toBe('button');
    expect(body.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 42 });
    expect(body.props.accessibilityState).toBeUndefined();
    expect(body.props.accessibilityLabel).toBe('doc.pdf, 42%');

    renderer.unmount();
  });

  it('exposes busy button semantics when progress is indeterminate', async () => {
    const renderer = await mount([makeAttachment({ status: 'uploading', progress: null })]);

    const body = chipBody(renderer.root);
    expect(body.props.accessibilityRole).toBe('button');
    expect(body.props.accessibilityState).toEqual({ busy: true });
    expect(body.props.accessibilityValue).toBeUndefined();
    expect(body.props.accessibilityLabel).toBe('doc.pdf, Uploading…');

    renderer.unmount();
  });

  it('labels a done image chip from describeAttachmentChip over a decorative thumbnail', async () => {
    const renderer = await mount([
      makeAttachment({ kind: 'image', filename: 'photo.png', status: 'uploaded', progress: 1 }),
    ]);

    const body = chipBody(renderer.root);
    expect(body.props.accessibilityLabel).toBe('photo.png, Uploaded');
    // Terminal states are static content — no progressbar semantics, but the
    // body is now tappable, so it announces as a button.
    expect(body.props.accessibilityRole).toBe('button');
    expect(body.props.accessibilityValue).toBeUndefined();

    const thumbnails = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Image'
    );
    expect(thumbnails).toHaveLength(1);
    // The thumbnail stays decorative; the accessible body owns the label.
    expect(thumbnails[0]?.props.accessible).toBeUndefined();
    expect(thumbnails[0]?.props.accessibilityLabel).toBeUndefined();

    renderer.unmount();
  });

  it('removes the summary container role from the strip scroll view', async () => {
    const renderer = await mount([makeAttachment({})]);

    const scrollViews = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'ScrollView'
    );
    expect(scrollViews).toHaveLength(1);
    expect(scrollViews[0]?.props.accessibilityRole).toBeUndefined();
    expect(scrollViews[0]?.props.accessibilityLabel).toBeUndefined();

    renderer.unmount();
  });

  it('hides the chip body visual descendants so only the labeled body is announced', async () => {
    const renderer = await mount([makeAttachment({})]);

    const body = chipBody(renderer.root);
    expect(body.props.accessibilityLabel).toBe('doc.pdf, Uploaded');

    // One hidden wrapper per chip body: every visual child (Text nodes,
    // thumbnail, ActivityIndicator) lives inside it and is excluded from the
    // accessibility tree, so the body cannot produce duplicate announcements.
    const wrapper = chipContentWrapper(renderer.root);
    expect(wrapper.props.accessibilityElementsHidden).toBe(true);

    renderer.unmount();
  });

  it('exposes a labelled Retry and Remove control for a retryable failure', async () => {
    const onRetry = vi.fn<() => void>();
    const onRemove = vi.fn<() => void>();
    const renderer = await mount(
      [makeAttachment({ status: 'error', terminal: false, progress: null })],
      { onRetry, onRemove }
    );

    const body = chipBody(renderer.root);
    expect(body.props.accessibilityLabel).toBe('doc.pdf, Upload failed. Tap to retry.');

    const retry = pressableByLabel(renderer.root, 'Retry uploading doc.pdf');
    const remove = pressableByLabel(renderer.root, 'Remove attachment doc.pdf');
    expect(retry).toBeDefined();
    expect(remove).toBeDefined();
    expect(retry?.props.accessibilityRole).toBe('button');

    if (!retry || !remove) {
      throw new Error('Retry and Remove buttons must both render for a retryable chip');
    }
    await act(async () => {
      await Promise.resolve();
      (retry.props.onPress as () => void)();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
      (remove.props.onPress as () => void)();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('omits Retry but keeps Remove for a non-retryable failure', async () => {
    const renderer = await mount([
      makeAttachment({ status: 'error', terminal: true, progress: null }),
    ]);

    const body = chipBody(renderer.root);
    expect(body.props.accessibilityLabel).toBe("doc.pdf, This file can't be uploaded.");

    const retry = pressableByLabel(renderer.root, 'Retry uploading doc.pdf');
    const remove = pressableByLabel(renderer.root, 'Remove attachment doc.pdf');
    expect(retry).toBeUndefined();
    expect(remove).toBeDefined();

    renderer.unmount();
  });

  it('unmounts the strip when there are no attachments (empty state is structural)', async () => {
    const renderer = await mount([]);
    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();
  });
});

describe('AttachmentPreviewStrip — tappable unsent chips', () => {
  it('opens the image viewer when an uploaded image chip is pressed', async () => {
    const renderer = await mount([
      makeAttachment({
        kind: 'image',
        filename: 'photo.png',
        localUri: 'file:///cache/photo.png',
        status: 'uploaded',
        progress: 1,
      }),
    ]);

    await pressBody(renderer.root);

    const viewers = nodesByType(renderer.root, 'ImageViewerModal');
    expect(viewers).toHaveLength(1);
    expect(viewers[0]?.props.visible).toBe(true);
    expect(viewers[0]?.props.uri).toBe('file:///cache/photo.png');
    expect(viewers[0]?.props.filename).toBe('photo.png');
    expect(viewers[0]?.props.onShare).toBeUndefined();
    expect(shareLocalFile).not.toHaveBeenCalled();
    expect(fileText).not.toHaveBeenCalled();
    expect(showActionSheetWithOptions).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('opens a markdown preview for an uploaded markdown chip', async () => {
    const renderer = await mount([markdownAttachment()]);

    await pressBody(renderer.root);

    expect(showActionSheetWithOptions).not.toHaveBeenCalled();
    expect(expoFileSystemMock.File).toHaveBeenCalledWith('file:///cache/notes.md');

    const markdown = nodesByType(renderer.root, 'MarkdownText');
    expect(markdown).toHaveLength(1);
    expect(markdown[0]?.props.value).toBe('# Hello');

    const headers = nodesByType(renderer.root, 'SheetHeader');
    expect(headers).toHaveLength(1);
    expect(headers[0]?.props.title).toBe('notes.md');

    expect(shareLocalFile).not.toHaveBeenCalled();
    expect(nodesByType(renderer.root, 'ImageViewerModal')).toHaveLength(0);
    expect(nodesByType(renderer.root, 'SelectableText')).toHaveLength(0);

    renderer.unmount();
  });

  it('shows the empty copy for an empty markdown file', async () => {
    fileText.mockResolvedValueOnce('');
    const renderer = await mount([markdownAttachment()]);

    await pressBody(renderer.root);

    expect(nodesByType(renderer.root, 'MarkdownText')).toHaveLength(0);
    const texts = nodesByType(renderer.root, 'Text');
    expect(texts.some(node => node.props.children === 'This file is empty.')).toBe(true);
    expect(shareLocalFile).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('toasts when a markdown file read throws', async () => {
    fileText.mockRejectedValueOnce(new Error('boom'));
    const renderer = await mount([markdownAttachment()]);

    await pressBody(renderer.root);

    expect(toast.error).toHaveBeenCalledWith('Failed to open file. Please try again.');
    expect(nodesByType(renderer.root, 'MarkdownText')).toHaveLength(0);

    renderer.unmount();
  });

  it('shows the unknown-file action sheet for a pdf chip', async () => {
    const renderer = await mount([makeAttachment({})]);

    await pressBody(renderer.root);

    expect(showActionSheetWithOptions).toHaveBeenCalledTimes(1);
    expect(showActionSheetWithOptions).toHaveBeenCalledWith(
      { options: ['Open as text', 'Open in external app', 'Cancel'], cancelButtonIndex: 2 },
      expect.any(Function)
    );
    expect(shareLocalFile).not.toHaveBeenCalled();
    expect(nodesByType(renderer.root, 'ImageViewerModal')).toHaveLength(0);
    expect(nodesByType(renderer.root, 'MarkdownText')).toHaveLength(0);
    expect(nodesByType(renderer.root, 'SelectableText')).toHaveLength(0);

    renderer.unmount();
  });

  it('opens a text preview when Open as text is chosen', async () => {
    const renderer = await mount([makeAttachment({})]);

    await chooseSheetOption(renderer.root, 0);

    const selectable = nodesByType(renderer.root, 'SelectableText');
    expect(selectable).toHaveLength(1);
    expect(selectable[0]?.props.children).toBe('# Hello');
    expect(shareLocalFile).not.toHaveBeenCalled();
    expect(nodesByType(renderer.root, 'MarkdownText')).toHaveLength(0);

    renderer.unmount();
  });

  it('shares the file when Open in external app is chosen', async () => {
    const renderer = await mount([makeAttachment({})]);

    await chooseSheetOption(renderer.root, 1);

    expect(shareLocalFile).toHaveBeenCalledTimes(1);
    expect(shareLocalFile).toHaveBeenCalledWith('file:///cache/doc.pdf', {
      mimeType: 'application/pdf',
    });
    expect(nodesByType(renderer.root, 'SelectableText')).toHaveLength(0);
    expect(nodesByType(renderer.root, 'MarkdownText')).toHaveLength(0);

    renderer.unmount();
  });

  it('does nothing when Cancel is chosen', async () => {
    const renderer = await mount([makeAttachment({})]);

    await chooseSheetOption(renderer.root, 2);

    expect(shareLocalFile).not.toHaveBeenCalled();
    expect(nodesByType(renderer.root, 'SelectableText')).toHaveLength(0);
    expect(nodesByType(renderer.root, 'MarkdownText')).toHaveLength(0);
    expect(nodesByType(renderer.root, 'ImageViewerModal')).toHaveLength(0);

    renderer.unmount();
  });

  it('keeps Retry and Remove working for a retryable error chip', async () => {
    const onRetry = vi.fn<() => void>();
    const onRemove = vi.fn<() => void>();
    const renderer = await mount(
      [makeAttachment({ status: 'error', terminal: false, progress: null })],
      { onRetry, onRemove }
    );

    const retry = pressableByLabel(renderer.root, 'Retry uploading doc.pdf');
    const remove = pressableByLabel(renderer.root, 'Remove attachment doc.pdf');
    if (!retry || !remove) {
      throw new Error('Retry and Remove buttons must both render for a retryable chip');
    }
    await act(async () => {
      await Promise.resolve();
      (retry.props.onPress as () => void)();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(shareLocalFile).not.toHaveBeenCalled();
    expect(showActionSheetWithOptions).not.toHaveBeenCalled();
    expect(nodesByType(renderer.root, 'ImageViewerModal')).toHaveLength(0);

    await act(async () => {
      await Promise.resolve();
      (remove.props.onPress as () => void)();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('opens the action sheet for a non-retryable error document chip', async () => {
    const renderer = await mount([
      makeAttachment({ status: 'error', terminal: true, progress: null }),
    ]);

    const remove = pressableByLabel(renderer.root, 'Remove attachment doc.pdf');
    expect(remove).toBeDefined();

    const body = chipBody(renderer.root);
    expect(body.type).toBe('Pressable');
    expect(body.props.accessible).toBe(true);

    await pressBody(renderer.root);
    expect(showActionSheetWithOptions).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('toasts the typed share failure', async () => {
    const renderer = await mount([makeAttachment({})]);

    vi.mocked(shareLocalFile).mockRejectedValueOnce(new ShareRemoteFileError('download-failed'));

    await chooseSheetOption(renderer.root, 1);

    expect(toast.error).toHaveBeenCalledWith('Failed to share file. Please try again.');

    renderer.unmount();
  });

  it('toasts when sharing is unavailable on the device', async () => {
    const renderer = await mount([makeAttachment({})]);

    vi.mocked(shareLocalFile).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(getShareRemoteFileReason).mockReturnValueOnce('sharing-unavailable');

    await chooseSheetOption(renderer.root, 1);

    expect(toast.error).toHaveBeenCalledWith('File sharing is not available on this device.');

    // Reset the reason mock so later cases keep the default `null` reason.
    vi.mocked(getShareRemoteFileReason).mockReturnValue(null);

    renderer.unmount();
  });

  it('toasts a generic share failure', async () => {
    const renderer = await mount([makeAttachment({})]);

    vi.mocked(shareLocalFile).mockRejectedValueOnce(new Error('boom'));

    await chooseSheetOption(renderer.root, 1);

    expect(toast.error).toHaveBeenCalledWith('Share failed');

    renderer.unmount();
  });

  it('toasts when Open as text read throws', async () => {
    fileText.mockRejectedValueOnce(new Error('boom'));
    const renderer = await mount([makeAttachment({})]);

    await chooseSheetOption(renderer.root, 0);

    expect(toast.error).toHaveBeenCalledWith('Failed to open file. Please try again.');
    expect(nodesByType(renderer.root, 'SelectableText')).toHaveLength(0);

    renderer.unmount();
  });
});

describe('AttachmentPreviewStrip — text preview sheet surface', () => {
  async function openMarkdownPreview(): Promise<TestRenderer.ReactTestRenderer> {
    const renderer = await mount([markdownAttachment()]);
    await pressBody(renderer.root);
    return renderer;
  }

  it('renders the native pageSheet Modal on iOS', async () => {
    const renderer = await openMarkdownPreview();

    const modals = nodesByType(renderer.root, 'Modal');
    expect(modals).toHaveLength(1);
    expect(modals[0]?.props.animationType).toBe('slide');
    expect(modals[0]?.props.presentationStyle).toBe('pageSheet');
    expect(modals[0]?.props.transparent).toBeUndefined();
    expect(findByTestID(renderer.root, 'session-page-sheet-scrim')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'session-page-sheet-surface')).toHaveLength(0);

    renderer.unmount();
  });

  it('renders a transparent Modal with a blocking scrim and half-height surface on Android', async () => {
    reactNativeMock.Platform.OS = 'android';
    reactNativeMock.useWindowDimensions.mockReturnValue({ width: 390, height: 800 });
    safeAreaMock.useSafeAreaInsets.mockReturnValue({ top: 24, bottom: 34 });

    const renderer = await openMarkdownPreview();

    const modals = nodesByType(renderer.root, 'Modal');
    expect(modals).toHaveLength(1);
    expect(modals[0]?.props.transparent).toBe(true);

    const scrim = findByTestID(renderer.root, 'session-page-sheet-scrim');
    expect(scrim).toHaveLength(1);
    // The scrim is a Pressable that consumes touches, so the session behind
    // cannot receive them.
    expect(scrim[0]?.type).toBe('Pressable');

    const surface = findByTestID(renderer.root, 'session-page-sheet-surface');
    expect(surface).toHaveLength(1);
    // usable = 800 - 24 - 34 = 742; half = 371.
    expect(surface[0]?.props.style).toEqual({ height: 371 });

    renderer.unmount();
  });

  it('closes the preview when the Android scrim is pressed', async () => {
    reactNativeMock.Platform.OS = 'android';
    const renderer = await openMarkdownPreview();

    const scrim = findByTestID(renderer.root, 'session-page-sheet-scrim')[0];
    if (!scrim) {
      throw new Error('scrim not found');
    }
    await act(async () => {
      await Promise.resolve();
      (scrim.props.onPress as () => void)();
    });

    expect(nodesByType(renderer.root, 'Modal')).toHaveLength(0);

    renderer.unmount();
  });

  it('closes the preview when Android Back fires onRequestClose', async () => {
    reactNativeMock.Platform.OS = 'android';
    const renderer = await openMarkdownPreview();

    const modal = nodesByType(renderer.root, 'Modal')[0];
    if (!modal) {
      throw new Error('Modal not found');
    }
    await act(async () => {
      await Promise.resolve();
      (modal.props.onRequestClose as () => void)();
    });

    expect(nodesByType(renderer.root, 'Modal')).toHaveLength(0);

    renderer.unmount();
  });

  it('closes the preview when Done is pressed', async () => {
    const renderer = await openMarkdownPreview();

    const header = nodesByType(renderer.root, 'SheetHeader')[0];
    if (!header) {
      throw new Error('SheetHeader not found');
    }
    await act(async () => {
      await Promise.resolve();
      (header.props.onDone as () => void)();
    });

    expect(nodesByType(renderer.root, 'Modal')).toHaveLength(0);

    renderer.unmount();
  });
});
