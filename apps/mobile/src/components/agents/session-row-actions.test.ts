import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionResumeUrl } from '@kilocode/app-shared/universal-links';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';

import {
  buildSessionActionMenuItems,
  copySessionLink,
  showRenamePrompt,
} from './session-row-actions';

const reactNativeMock = vi.hoisted(() => ({
  alert: vi.fn(),
  prompt: vi.fn(),
}));

vi.mock('react-native', () => ({
  Alert: { alert: reactNativeMock.alert, prompt: reactNativeMock.prompt },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('copySessionLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies the anchored resume URL and commits with the success haptic', async () => {
    vi.mocked(Clipboard.setStringAsync).mockResolvedValue(true);

    await expect(copySessionLink('ses-1', 'msg_7')).resolves.toBe(true);

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      sessionResumeUrl({ sessionId: 'ses-1', anchorMessageId: 'msg_7' })
    );
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success
    );
  });

  it('copies the session-top link when the position is unknown', async () => {
    vi.mocked(Clipboard.setStringAsync).mockResolvedValue(true);

    await expect(copySessionLink('ses-1', null)).resolves.toBe(true);

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      sessionResumeUrl({ sessionId: 'ses-1', anchorMessageId: null })
    );
  });

  it('reports failure without the success haptic when the clipboard rejects', async () => {
    vi.mocked(Clipboard.setStringAsync).mockRejectedValue(new Error('clipboard unavailable'));

    await expect(copySessionLink('ses-1', 'msg_7')).resolves.toBe(false);

    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it('reports failure when the clipboard resolves false', async () => {
    vi.mocked(Clipboard.setStringAsync).mockResolvedValue(false);

    await expect(copySessionLink('ses-1', null)).resolves.toBe(false);

    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });
});

type PromptButton = {
  text?: string;
  style?: string;
  onPress?: (value?: string) => void;
};

/** Invoke the confirm button of the last `Alert.prompt` with `value`. */
function confirmWith(value: string) {
  const call = vi.mocked(Alert.prompt).mock.calls.at(-1);
  if (!call) {
    throw new Error('Alert.prompt was not called');
  }
  const buttons = call[2] as unknown as PromptButton[];
  const rename = buttons.find(button => button.style !== 'cancel');
  rename?.onPress?.(value);
}

describe('showRenamePrompt', () => {
  afterEach(() => {
    vi.mocked(Alert.prompt).mockClear();
  });

  it('does not rename when the prefilled title is confirmed unchanged', () => {
    // Confirming the seeded value without editing must be a no-op, not a
    // rename to that value.
    const onRename = vi.fn<(newTitle: string) => void>();
    showRenamePrompt('Untitled session', onRename);
    confirmWith('Untitled session');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('renames with the trimmed value when the title changed', () => {
    const onRename = vi.fn<(newTitle: string) => void>();
    showRenamePrompt('Untitled session', onRename);
    confirmWith('  Fix login  ');
    expect(onRename).toHaveBeenCalledWith('Fix login');
  });

  it('does not rename to a blank value', () => {
    const onRename = vi.fn<(newTitle: string) => void>();
    showRenamePrompt('Untitled session', onRename);
    confirmWith('   ');
    expect(onRename).not.toHaveBeenCalled();
  });
});

const noop = () => undefined;

describe('buildSessionActionMenuItems', () => {
  it('omits exit without onExit, marks delete destructive and reuses labels', () => {
    const { items, cancelLabel } = buildSessionActionMenuItems({
      onCopySessionId: noop,
      onRename: noop,
      onDelete: noop,
    });

    expect(items.map(item => item.key)).toEqual(['copyId', 'rename', 'delete']);
    expect(items.map(item => item.label)).toEqual(['Copy session ID', 'Rename', 'Delete session']);
    expect(items[2]?.destructive).toBe(true);
    expect(cancelLabel).toBe('Cancel');
  });

  it('marks exit destructive only when delete is absent', () => {
    const { items } = buildSessionActionMenuItems({ onCopySessionId: noop, onExit: noop });

    expect(items.map(item => item.key)).toEqual(['copyId', 'exit']);
    expect(items[1]?.destructive).toBe(true);
  });
});
