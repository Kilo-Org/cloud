/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/attachment-preview-strip.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type QueuedAttachment } from '@kilocode/kilo-chat-hooks';

import { MessageAttachmentPreviewChip } from './message-attachment-preview-chip';

const reactNativeMock = vi.hoisted(() => ({
  Platform: { OS: 'ios' as string },
}));

vi.mock('react-native', () => ({
  Platform: reactNativeMock.Platform,
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
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

type HitSlop = { top: number; bottom: number; left: number; right: number };

const RETRY_LABEL = 'Retry upload for photo.jpg';
const REMOVE_LABEL = 'Remove photo.jpg';

// The visible `h-7 w-7` badge. Tailwind's `h-7` is 1.75rem and NativeWind
// renders 1rem as 14 on native, so the badge measures 24.5pt — not the 28pt the
// 4px spacing scale implies (measured 65px at density 420 = 2.625 from the
// Android emulator). A slop computed from 28 left the Android target at 44.5dp.
const CONTROL_BADGE_SIZE = 24.5;

function makeFailedImageRow(): QueuedAttachment {
  return {
    tempId: 'a1',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    size: 2048,
    status: 'failed',
    progress: 1,
  };
}

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(MessageAttachmentPreviewChip, {
        row: makeFailedImageRow(),
        localUri: 'file:///cache/photo.jpg',
        onRemove: () => undefined,
        onRetry: () => undefined,
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function hitSlopFor(root: TestRenderer.ReactTestInstance, label: string): HitSlop {
  const control = root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === label
  );
  return control.props.hitSlop as HitSlop;
}

beforeEach(() => {
  reactNativeMock.Platform.OS = 'ios';
});

describe('MessageAttachmentPreviewChip — control hit targets', () => {
  // Each control renders an `h-7 w-7` badge. NativeWind renders 1rem as 14 on
  // native, so the badge is 24.5pt, not the 28pt the 4px spacing scale implies;
  // asserting against the real size catches a slop computed from 28, which left
  // the Android target at 44.5dp instead of 48dp.
  it('keeps the Retry target at the 44pt minimum on iOS', async () => {
    const renderer = await mount();

    const hitSlop = hitSlopFor(renderer.root, RETRY_LABEL);
    expect(CONTROL_BADGE_SIZE + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(44);
    expect(CONTROL_BADGE_SIZE + hitSlop.left + hitSlop.right).toBeGreaterThanOrEqual(44);

    renderer.unmount();
  });

  it('keeps the Remove target at the 44pt minimum on iOS', async () => {
    const renderer = await mount();

    const hitSlop = hitSlopFor(renderer.root, REMOVE_LABEL);
    expect(CONTROL_BADGE_SIZE + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(44);
    expect(CONTROL_BADGE_SIZE + hitSlop.left + hitSlop.right).toBeGreaterThanOrEqual(44);

    renderer.unmount();
  });

  it('keeps the Retry target at the 48dp minimum on Android', async () => {
    reactNativeMock.Platform.OS = 'android';
    const renderer = await mount();

    const hitSlop = hitSlopFor(renderer.root, RETRY_LABEL);
    expect(CONTROL_BADGE_SIZE + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(48);
    expect(CONTROL_BADGE_SIZE + hitSlop.left + hitSlop.right).toBeGreaterThanOrEqual(48);

    renderer.unmount();
  });

  it('keeps the Remove target at the 48dp minimum on Android', async () => {
    reactNativeMock.Platform.OS = 'android';
    const renderer = await mount();

    const hitSlop = hitSlopFor(renderer.root, REMOVE_LABEL);
    expect(CONTROL_BADGE_SIZE + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(48);
    expect(CONTROL_BADGE_SIZE + hitSlop.left + hitSlop.right).toBeGreaterThanOrEqual(48);

    renderer.unmount();
  });
});
