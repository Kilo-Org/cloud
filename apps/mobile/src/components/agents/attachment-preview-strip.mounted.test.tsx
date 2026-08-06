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
vi.mock('lucide-react-native', () => ({
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

/** The non-accessible chip container — identified by its size/position classes. */
function chipContainer(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('relative mr-2')
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

// Row 3.3 control-layout geometry: Tailwind spacing is 4px per unit, so
// `h-7 w-7` is a 28px button and `-1` insets it 4px from the chip edge.
// Each button plus the 8pt `hitSlop` on every side must form a separate
// 44pt effective target.
const TAILWIND_UNIT = 4;
const BUTTON_SIZE = 7 * TAILWIND_UNIT;
const BUTTON_INSET = TAILWIND_UNIT;
const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

// Chip dimensions from the strip's size classes: `w-20 h-16` (image) and
// `w-48 h-12` (document).
const CHIP_DIMS = {
  image: { width: 20 * TAILWIND_UNIT, height: 16 * TAILWIND_UNIT },
  document: { width: 48 * TAILWIND_UNIT, height: 12 * TAILWIND_UNIT },
} as const;

type Rect = { left: number; top: number; right: number; bottom: number };

function controlVisibleRect(className: string, dims: { width: number; height: number }): Rect {
  // `-1` insets the button from the left/top edge; the mirror side is the
  // chip dimension minus the inset and the button size.
  const left = className.includes('left-1')
    ? BUTTON_INSET
    : dims.width - BUTTON_INSET - BUTTON_SIZE;
  const top = className.includes('top-1') ? BUTTON_INSET : dims.height - BUTTON_INSET - BUTTON_SIZE;
  return {
    left,
    top,
    right: left + BUTTON_SIZE,
    bottom: top + BUTTON_SIZE,
  };
}

function expandByHitSlop(rect: Rect): Rect {
  return {
    left: rect.left - HIT_SLOP.left,
    top: rect.top - HIT_SLOP.top,
    right: rect.right + HIT_SLOP.right,
    bottom: rect.bottom + HIT_SLOP.bottom,
  };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
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

  it('keeps the container non-accessible so Retry and Remove are reachable siblings', async () => {
    const renderer = await mount([
      makeAttachment({ status: 'error', terminal: false, progress: null }),
    ]);

    const container = chipContainer(renderer.root);
    expect(container.props.accessible).toBeUndefined();
    expect(container.props.accessibilityRole).toBeUndefined();
    expect(container.props.accessibilityLabel).toBeUndefined();

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
    const bodyTexts = body.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Text'
    );
    expect(bodyTexts.length).toBeGreaterThan(0);
    const wrapperTexts = wrapper.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Text'
    );
    expect(wrapperTexts.length).toBe(bodyTexts.length);

    renderer.unmount();
  });

  it('keeps the image thumbnail inside the hidden body content', async () => {
    const renderer = await mount([
      makeAttachment({ kind: 'image', filename: 'photo.png', status: 'uploaded', progress: 1 }),
    ]);

    const wrapper = chipContentWrapper(renderer.root);
    const thumbnails = wrapper.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Image'
    );
    expect(thumbnails).toHaveLength(1);
    // Decorative thumbnail stays inside the hidden content: no label of its own.
    expect(thumbnails[0]?.props.accessible).toBeUndefined();
    expect(thumbnails[0]?.props.accessibilityLabel).toBeUndefined();

    renderer.unmount();
  });

  it('shows a 44pt Retry sibling and the Remove sibling for a retryable failure', async () => {
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
    // 28pt visible button + 8pt slop on every side = 44pt effective target.
    expect(retry?.props.hitSlop).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });
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

  async function assertDistinctTargets(kind: 'image' | 'document'): Promise<void> {
    const attachment = makeAttachment({
      id: `retry-${kind}`,
      kind,
      filename: kind === 'image' ? 'photo.png' : 'doc.pdf',
      status: 'error',
      terminal: false,
      progress: null,
    });
    const renderer = await mount([attachment]);

    const retry = pressableByLabel(renderer.root, `Retry uploading ${attachment.filename}`);
    const remove = pressableByLabel(renderer.root, `Remove attachment ${attachment.filename}`);
    if (!retry || !remove) {
      throw new Error('Retry and Remove must both render for a retryable chip');
    }

    // Distinct layout regions: Retry owns the bottom-left corner, Remove
    // owns the top-right corner.
    expect(String(retry.props.className)).toContain('bottom-1');
    expect(String(retry.props.className)).toContain('left-1');
    expect(String(remove.props.className)).toContain('top-1');
    expect(String(remove.props.className)).toContain('right-1');
    expect(retry.props.hitSlop).toEqual(HIT_SLOP);
    expect(remove.props.hitSlop).toEqual(HIT_SLOP);

    const dims = CHIP_DIMS[kind];
    const retryRect = expandByHitSlop(controlVisibleRect(String(retry.props.className), dims));
    const removeRect = expandByHitSlop(controlVisibleRect(String(remove.props.className), dims));
    expect(intersects(retryRect, removeRect), `${kind} chip hit slops must not overlap`).toBe(
      false
    );

    renderer.unmount();
  }

  it('keeps Retry and Remove in distinct corners with non-overlapping 44pt effective targets', async () => {
    await assertDistinctTargets('image');
    await assertDistinctTargets('document');
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
