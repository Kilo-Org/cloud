import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionResumeUrl } from '@kilocode/app-shared/universal-links';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';

import { copySessionLink, showRenamePrompt, showSessionActionMenu } from './session-row-actions';
import { type ThemedActionSheetOptions } from '@/lib/hooks/use-themed-action-sheet';

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

type SheetOptions = {
  options: string[];
  cancelButtonIndex?: number;
  destructiveButtonIndex?: number | number[];
  containerStyle?: { paddingBottom?: number; backgroundColor?: string };
  textStyle?: { color: string };
  titleTextStyle?: { color: string };
  messageTextStyle?: { color: string };
  destructiveColor?: string;
};

const themedSheet: ThemedActionSheetOptions = {
  containerStyle: { backgroundColor: '#17171A', paddingBottom: 12 },
  textStyle: { color: '#F2F0EB' },
  titleTextStyle: { color: '#8A8680' },
  messageTextStyle: { color: '#8A8680' },
  destructiveColor: '#F28B7A',
};

type Captured = {
  sheetOptions: SheetOptions;
  onSelect: (index?: number) => void;
};

function openMenu(args: {
  onRename?: () => void;
  onExit?: () => void;
  onDelete?: () => void;
  themedSheet?: ThemedActionSheetOptions;
}): Captured & {
  onCopySessionId: ReturnType<typeof vi.fn>;
  onRename: ReturnType<typeof vi.fn> | undefined;
  onExit: ReturnType<typeof vi.fn> | undefined;
  onDelete: ReturnType<typeof vi.fn> | undefined;
} {
  const onCopySessionId = vi.fn(() => undefined);
  const onRename = args.onRename ? vi.fn(() => undefined) : undefined;
  const onExit = args.onExit ? vi.fn(() => undefined) : undefined;
  const onDelete = args.onDelete ? vi.fn(() => undefined) : undefined;
  const captured: { current: Captured | null } = { current: null };

  showSessionActionMenu({
    showActionSheetWithOptions: (options, select) => {
      captured.current = {
        sheetOptions: options as SheetOptions,
        onSelect: select,
      };
    },
    onCopySessionId,
    ...(onRename ? { onRename } : {}),
    ...(onExit ? { onExit } : {}),
    ...(onDelete ? { onDelete } : {}),
    themedSheet: args.themedSheet ?? themedSheet,
  });

  if (!captured.current) {
    throw new Error('showActionSheetWithOptions was not called');
  }
  return {
    ...captured.current,
    onCopySessionId,
    onRename,
    onExit,
    onDelete,
  };
}

describe('showSessionActionMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds copy + cancel when rename and delete are omitted', () => {
    const { sheetOptions } = openMenu({});

    expect(sheetOptions.options).toEqual(['Copy session ID', 'Cancel']);
    expect(sheetOptions.cancelButtonIndex).toBe(1);
    expect(sheetOptions.destructiveButtonIndex).toBeUndefined();
    expect(sheetOptions.containerStyle).toEqual({
      backgroundColor: '#17171A',
      paddingBottom: 12,
    });
    expect(sheetOptions.textStyle).toEqual({ color: '#F2F0EB' });
    expect(sheetOptions.destructiveColor).toBe('#F28B7A');
  });

  it('includes rename when onRename is provided', () => {
    const { sheetOptions } = openMenu({ onRename: () => undefined });

    expect(sheetOptions.options).toEqual(['Copy session ID', 'Rename', 'Cancel']);
    expect(sheetOptions.cancelButtonIndex).toBe(2);
    expect(sheetOptions.destructiveButtonIndex).toBeUndefined();
  });

  it('includes delete with destructive index when onDelete is provided', () => {
    const { sheetOptions } = openMenu({ onDelete: () => undefined });

    expect(sheetOptions.options).toEqual(['Copy session ID', 'Delete session', 'Cancel']);
    expect(sheetOptions.cancelButtonIndex).toBe(2);
    expect(sheetOptions.destructiveButtonIndex).toBe(1);
  });

  it('includes copy, rename, delete, cancel in that order for full menu', () => {
    const { sheetOptions } = openMenu({
      onRename: () => undefined,
      onDelete: () => undefined,
      themedSheet: {
        ...themedSheet,
        containerStyle: { backgroundColor: '#17171A', paddingBottom: 34 },
      },
    });

    expect(sheetOptions.options).toEqual(['Copy session ID', 'Rename', 'Delete session', 'Cancel']);
    expect(sheetOptions.cancelButtonIndex).toBe(3);
    expect(sheetOptions.destructiveButtonIndex).toBe(2);
    expect(sheetOptions.containerStyle).toEqual({
      backgroundColor: '#17171A',
      paddingBottom: 34,
    });
  });

  it('dispatches copy / rename / delete by index and ignores cancel', () => {
    const { onSelect, onCopySessionId, onRename, onDelete } = openMenu({
      onRename: () => undefined,
      onDelete: () => undefined,
    });

    onSelect(0);
    expect(onCopySessionId).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    onSelect(1);
    expect(onRename).toHaveBeenCalledTimes(1);

    onSelect(2);
    expect(onDelete).toHaveBeenCalledTimes(1);

    onSelect(3);
    onSelect(undefined);
    expect(onCopySessionId).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('dispatches rename at index 1 when delete is absent', () => {
    const { onSelect, onRename, onCopySessionId } = openMenu({
      onRename: () => undefined,
    });

    onSelect(1);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onCopySessionId).not.toHaveBeenCalled();
  });

  it('includes copy, rename, exit, cancel with destructive exit when delete is absent', () => {
    const { sheetOptions } = openMenu({
      onRename: () => undefined,
      onExit: () => undefined,
    });

    expect(sheetOptions.options).toEqual(['Copy session ID', 'Rename', 'Exit session', 'Cancel']);
    expect(sheetOptions.cancelButtonIndex).toBe(3);
    expect(sheetOptions.destructiveButtonIndex).toBe(2);
  });

  it('omits exit session when onExit is absent', () => {
    const { sheetOptions } = openMenu({
      onRename: () => undefined,
      onDelete: () => undefined,
    });

    expect(sheetOptions.options).toEqual(['Copy session ID', 'Rename', 'Delete session', 'Cancel']);
    expect(sheetOptions.options).not.toContain('Exit session');
  });

  it('orders copy, rename, exit, delete, cancel with destructive delete when both exist', () => {
    const { sheetOptions } = openMenu({
      onRename: () => undefined,
      onExit: () => undefined,
      onDelete: () => undefined,
    });

    expect(sheetOptions.options).toEqual([
      'Copy session ID',
      'Rename',
      'Exit session',
      'Delete session',
      'Cancel',
    ]);
    expect(sheetOptions.cancelButtonIndex).toBe(4);
    expect(sheetOptions.destructiveButtonIndex).toBe(3);
  });

  it('dispatches exit at its index without copy, rename, or delete', () => {
    const { onSelect, onExit, onCopySessionId, onRename, onDelete } = openMenu({
      onRename: () => undefined,
      onExit: () => undefined,
      onDelete: () => undefined,
    });

    onSelect(2);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onCopySessionId).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});

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
