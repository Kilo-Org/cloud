import { beforeEach, describe, expect, it, vi } from 'vitest';

import { showSessionActionMenu } from './session-row-actions';

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
  NotificationFeedbackType: { Warning: 'warning', Success: 'success' },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type SheetOptions = {
  options: string[];
  cancelButtonIndex?: number;
  destructiveButtonIndex?: number | number[];
  containerStyle?: { paddingBottom?: number };
};

type Captured = {
  sheetOptions: SheetOptions;
  onSelect: (index?: number) => void;
};

function openMenu(args: {
  onRename?: () => void;
  onExit?: () => void;
  onDelete?: () => void;
  bottomInset?: number;
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
    bottomInset: args.bottomInset ?? 12,
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
    expect(sheetOptions.containerStyle).toEqual({ paddingBottom: 12 });
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
      bottomInset: 34,
    });

    expect(sheetOptions.options).toEqual(['Copy session ID', 'Rename', 'Delete session', 'Cancel']);
    expect(sheetOptions.cancelButtonIndex).toBe(3);
    expect(sheetOptions.destructiveButtonIndex).toBe(2);
    expect(sheetOptions.containerStyle).toEqual({ paddingBottom: 34 });
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
