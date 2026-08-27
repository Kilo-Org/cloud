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
import { AttachmentPreviewStrip, dragTargetIndex } from './attachment-preview-strip';

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

const gestureHandlerMock = vi.hoisted(() => {
  // One record per `Gesture.Pan()` call, in chip render order. Each builder
  // method is chainable and captures its callback so the test can fire
  // `onStart`/`onEnd` with a synthetic translation.
  const gestures: {
    onStart?: (event: { translationX: number }) => void;
    onEnd?: (event: { translationX: number }) => void;
  }[] = [];
  function makeGesture(): Record<string, unknown> {
    const record: (typeof gestures)[number] = {};
    const g: Record<string, unknown> = {};
    g.runOnJS = () => g;
    g.activateAfterLongPress = () => g;
    // eslint-disable-next-line promise/prefer-await-to-callbacks -- the mock captures the builder callback so the test can fire the drag
    g.onStart = (cb: unknown) => {
      record.onStart = cb as (typeof gestures)[number]['onStart'];
      return g;
    };
    // eslint-disable-next-line promise/prefer-await-to-callbacks -- the mock captures the builder callback so the test can fire the drag
    g.onEnd = (cb: unknown) => {
      record.onEnd = cb as (typeof gestures)[number]['onEnd'];
      return g;
    };
    gestures.push(record);
    return g;
  }
  return {
    gestures,
    reset: () => {
      gestures.length = 0;
    },
    makeGesture,
  };
});

const a11yMock = vi.hoisted(() => ({
  announceForA11y: vi.fn(),
  moveA11yFocus: vi.fn(),
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
vi.mock('react-native-gesture-handler', () => ({
  Gesture: { Pan: gestureHandlerMock.makeGesture },
  GestureDetector: 'GestureDetector',
  ScrollView: 'ScrollView',
}));
vi.mock('@/lib/a11y/announce', () => a11yMock);
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
  handlers: {
    onRemove?: () => void;
    onRetry?: () => void;
    onMove?: (id: string, direction: 'left' | 'right') => void;
    onReorder?: (fromIndex: number, toIndex: number) => void;
  } = {}
): Promise<Renderer> {
  const ref: { current: Renderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(AttachmentPreviewStrip, {
        attachments,
        onRemove: handlers.onRemove ?? (() => undefined),
        onRetry: handlers.onRetry ?? (() => undefined),
        onMove: handlers.onMove ?? (() => undefined),
        onReorder: handlers.onReorder ?? (() => undefined),
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

/** Every accessible chip body, in chip render order. */
function chipBodies(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      ((node.type as string) === 'View' || (node.type as string) === 'Pressable') &&
      node.props.accessible === true
  );
}

/** Every chip wrapper carrying an `onLayout` width measurement. */
function layoutNodes(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.props.onLayout === 'function');
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
  gestureHandlerMock.reset();
  a11yMock.moveA11yFocus.mockReset();
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
    expect(findByTestID(renderer.root, 'session-page-sheet-surface')).toHaveLength(0);

    renderer.unmount();
  });

  it('sizes the preview ScrollView to fill the sheet surface with flex-1', async () => {
    const renderer = await openMarkdownPreview();

    const previewScrollView = nodesByType(renderer.root, 'ScrollView').find(
      node => node.props.contentContainerClassName === 'px-6 pb-6 pt-2'
    );
    expect(previewScrollView?.props.className).toBe('flex-1');

    renderer.unmount();
  });

  it('renders an opaque full-window Modal padded by the top inset on Android', async () => {
    reactNativeMock.Platform.OS = 'android';
    safeAreaMock.useSafeAreaInsets.mockReturnValue({ top: 24, bottom: 34 });

    const renderer = await openMarkdownPreview();

    const modals = nodesByType(renderer.root, 'Modal');
    expect(modals).toHaveLength(1);
    expect(modals[0]?.props.transparent).toBeUndefined();

    const surface = findByTestID(renderer.root, 'session-page-sheet-surface');
    expect(surface).toHaveLength(1);
    // flex-1 fills the window; the padding clears the system status bar.
    expect(surface[0]?.props.className).toContain('flex-1');
    expect(surface[0]?.props.style).toEqual({ paddingTop: 24 });

    // The insets.bottom spacer clears the Android navigation bar.
    const spacers = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        (node.props.style as { height?: number } | undefined)?.height === 34 &&
        node.props.className === 'bg-background'
    );
    expect(spacers).toHaveLength(1);

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

describe('AttachmentPreviewStrip — thumbnail decode fallback', () => {
  it('shows the AlertCircle fallback while the upload spinner still renders', async () => {
    const renderer = await mount([
      makeAttachment({
        kind: 'image',
        filename: 'photo.png',
        status: 'uploading',
        progress: null,
      }),
    ]);

    const images = nodesByType(renderer.root, 'Image');
    expect(images).toHaveLength(1);
    expect(nodesByType(renderer.root, 'ActivityIndicator')).toHaveLength(1);

    const image = images[0];
    if (!image) {
      throw new Error('thumbnail Image missing');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });

    expect(nodesByType(renderer.root, 'Image')).toHaveLength(0);
    expect(nodesByType(renderer.root, 'AlertCircle')).toHaveLength(1);
    // The upload overlay is driven by status alone and stays unchanged.
    expect(nodesByType(renderer.root, 'ActivityIndicator')).toHaveLength(1);

    renderer.unmount();
  });

  it('shows the AlertCircle fallback with no spinner for an uploaded image', async () => {
    const renderer = await mount([
      makeAttachment({
        kind: 'image',
        filename: 'photo.png',
        status: 'uploaded',
        progress: 1,
      }),
    ]);

    const images = nodesByType(renderer.root, 'Image');
    expect(images).toHaveLength(1);
    expect(nodesByType(renderer.root, 'ActivityIndicator')).toHaveLength(0);

    const image = images[0];
    if (!image) {
      throw new Error('thumbnail Image missing');
    }
    await act(async () => {
      await Promise.resolve();
      (image.props.onError as () => void)();
    });

    expect(nodesByType(renderer.root, 'Image')).toHaveLength(0);
    expect(nodesByType(renderer.root, 'AlertCircle')).toHaveLength(1);
    expect(nodesByType(renderer.root, 'ActivityIndicator')).toHaveLength(0);

    renderer.unmount();
  });
});

describe('dragTargetIndex', () => {
  const UNIFORM = [192, 192, 192];

  it('stays put below the midpoint crossing', () => {
    expect(dragTargetIndex(0, UNIFORM, 0)).toBe(0);
    expect(dragTargetIndex(0, UNIFORM, 199)).toBe(0);
  });

  it('crosses one slot at the midpoint and clamps at the end', () => {
    expect(dragTargetIndex(0, UNIFORM, 200)).toBe(1);
    expect(dragTargetIndex(0, UNIFORM, 400)).toBe(2);
    expect(dragTargetIndex(0, UNIFORM, 9999)).toBe(2);
  });

  it('moves left symmetrically', () => {
    expect(dragTargetIndex(2, UNIFORM, -200)).toBe(1);
    expect(dragTargetIndex(2, UNIFORM, -400)).toBe(0);
    expect(dragTargetIndex(2, UNIFORM, -9999)).toBe(0);
  });

  it('uses each chip width for mixed image/document rows', () => {
    // image (80) then documents (192). Crossing 0 -> 1 needs 80/2 + 8 + 192/2 = 144.
    expect(dragTargetIndex(0, [80, 192, 192], 143)).toBe(0);
    expect(dragTargetIndex(0, [80, 192, 192], 144)).toBe(1);
    // Crossing 1 -> 0 back needs 192/2 + 8 + 80/2 = 144.
    expect(dragTargetIndex(1, [80, 192, 192], -143)).toBe(1);
    expect(dragTargetIndex(1, [80, 192, 192], -144)).toBe(0);
  });
});

describe('AttachmentPreviewStrip — accessible move actions', () => {
  it('offers Move left/right actions on each chip body and dispatches them', async () => {
    const onMove = vi.fn<(id: string, direction: 'left' | 'right') => void>();
    const renderer = await mount(
      [
        makeAttachment({ id: 'a1', filename: 'a.pdf' }),
        makeAttachment({ id: 'a2', filename: 'b.pdf' }),
        makeAttachment({ id: 'a3', filename: 'c.pdf' }),
      ],
      { onMove }
    );

    const bodies = chipBodies(renderer.root);
    expect(bodies).toHaveLength(3);

    // First chip: only Move right (no slot to the left).
    expect(bodies[0]?.props.accessibilityActions).toEqual([
      { name: 'moveRight', label: 'Move a.pdf right' },
    ]);
    // Last chip: only Move left.
    expect(bodies[2]?.props.accessibilityActions).toEqual([
      { name: 'moveLeft', label: 'Move c.pdf left' },
    ]);
    // Middle chip: both directions.
    expect(bodies[1]?.props.accessibilityActions).toEqual([
      { name: 'moveLeft', label: 'Move b.pdf left' },
      { name: 'moveRight', label: 'Move b.pdf right' },
    ]);

    const firstBody = bodies[0];
    if (!firstBody) {
      throw new Error('first chip body missing');
    }
    await act(async () => {
      await Promise.resolve();
      (
        firstBody.props.onAccessibilityAction as (event: {
          nativeEvent: { actionName: string };
        }) => void
      )({ nativeEvent: { actionName: 'moveRight' } });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onMove).toHaveBeenCalledWith('a1', 'right');
    expect(a11yMock.moveA11yFocus).toHaveBeenCalledTimes(1);

    const middleBody = bodies[1];
    if (!middleBody) {
      throw new Error('middle chip body missing');
    }
    await act(async () => {
      await Promise.resolve();
      (
        middleBody.props.onAccessibilityAction as (event: {
          nativeEvent: { actionName: string };
        }) => void
      )({ nativeEvent: { actionName: 'moveLeft' } });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onMove).toHaveBeenLastCalledWith('a2', 'left');
    expect(a11yMock.moveA11yFocus).toHaveBeenCalledTimes(2);

    renderer.unmount();
  });

  it('offers no move actions on a single chip', async () => {
    const renderer = await mount([makeAttachment({})]);
    const body = chipBody(renderer.root);
    expect(body.props.accessibilityActions).toBeUndefined();
    renderer.unmount();
  });
});

describe('AttachmentPreviewStrip — drag reorder', () => {
  function measureChips(renderer: Renderer, width: number): void {
    for (const node of layoutNodes(renderer.root)) {
      (node.props.onLayout as (event: { nativeEvent: { layout: { width: number } } }) => void)({
        nativeEvent: { layout: { width } },
      });
    }
  }

  it('reorders by drag once the finger crosses the neighbor midpoint', async () => {
    const onReorder = vi.fn<(fromIndex: number, toIndex: number) => void>();
    const renderer = await mount(
      [
        makeAttachment({ id: 'a1', filename: 'a.pdf' }),
        makeAttachment({ id: 'a2', filename: 'b.pdf' }),
        makeAttachment({ id: 'a3', filename: 'c.pdf' }),
      ],
      { onReorder }
    );

    // Every document chip measures 192pt wide (w-48).
    measureChips(renderer, 192);

    const firstGesture = gestureHandlerMock.gestures[0];
    if (!firstGesture) {
      throw new Error('first chip gesture not registered');
    }
    await act(async () => {
      await Promise.resolve();
      firstGesture.onStart?.({ translationX: 0 });
      firstGesture.onEnd?.({ translationX: 200 });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(0, 1);
    expect(a11yMock.moveA11yFocus).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('does not reorder when the drag stays under the midpoint', async () => {
    const onReorder = vi.fn<(fromIndex: number, toIndex: number) => void>();
    const renderer = await mount(
      [
        makeAttachment({ id: 'a1', filename: 'a.pdf' }),
        makeAttachment({ id: 'a2', filename: 'b.pdf' }),
      ],
      { onReorder }
    );
    measureChips(renderer, 192);

    const firstGesture = gestureHandlerMock.gestures[0];
    if (!firstGesture) {
      throw new Error('first chip gesture not registered');
    }
    await act(async () => {
      await Promise.resolve();
      firstGesture.onStart?.({ translationX: 0 });
      firstGesture.onEnd?.({ translationX: 100 });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onReorder).not.toHaveBeenCalled();
    expect(a11yMock.moveA11yFocus).not.toHaveBeenCalled();

    renderer.unmount();
  });
});

describe('AttachmentPreviewStrip — control hit targets', () => {
  // The Remove control renders a 28pt visible badge (h-7 w-7) and reaches the
  // platform minimum through its hitSlop. This catches a revert to the old
  // fixed 8pt slop, which leaves Android at 44dp instead of 48dp.
  function removeHitSlop(root: TestRenderer.ReactTestInstance): {
    top: number;
    bottom: number;
    left: number;
    right: number;
  } {
    const remove = pressableByLabel(root, 'Remove attachment doc.pdf');
    if (!remove) {
      throw new Error('Remove button missing');
    }
    return remove.props.hitSlop as {
      top: number;
      bottom: number;
      left: number;
      right: number;
    };
  }

  it('keeps the Remove target at the 44pt minimum on iOS', async () => {
    const renderer = await mount([makeAttachment({})]);

    const hitSlop = removeHitSlop(renderer.root);
    expect(28 + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(44);
    expect(28 + hitSlop.left + hitSlop.right).toBeGreaterThanOrEqual(44);

    renderer.unmount();
  });

  it('keeps the Remove target at the 48dp minimum on Android', async () => {
    reactNativeMock.Platform.OS = 'android';
    const renderer = await mount([makeAttachment({})]);

    const hitSlop = removeHitSlop(renderer.root);
    expect(28 + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(48);
    expect(28 + hitSlop.left + hitSlop.right).toBeGreaterThanOrEqual(48);

    renderer.unmount();
  });
});
