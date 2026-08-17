/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/markdown-image.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { type AgentAttachment } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { AttachmentPreviewStrip } from './attachment-preview-strip';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
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
      (node.type as string) === 'View' &&
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

describe('AttachmentPreviewStrip — mounted accessibility contract', () => {
  it('exposes determinate progressbar semantics while uploading', async () => {
    const renderer = await mount([makeAttachment({ status: 'uploading', progress: 0.42 })]);

    const body = chipBody(renderer.root);
    expect(body.props.accessibilityRole).toBe('progressbar');
    expect(body.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 42 });
    expect(body.props.accessibilityState).toBeUndefined();
    expect(body.props.accessibilityLabel).toBe('doc.pdf, 42%');

    renderer.unmount();
  });

  it('exposes busy progressbar semantics when progress is indeterminate', async () => {
    const renderer = await mount([makeAttachment({ status: 'uploading', progress: null })]);

    const body = chipBody(renderer.root);
    expect(body.props.accessibilityRole).toBe('progressbar');
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
    // Terminal states are static content — no progressbar semantics.
    expect(body.props.accessibilityRole).toBeUndefined();
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
