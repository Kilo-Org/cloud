import { beforeEach, describe, expect, it, vi } from 'vitest';

const setStringAsync = vi.fn();
const notificationAsync = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const showActionSheetWithOptions = vi.fn();

vi.mock('expo-clipboard', () => ({
  setStringAsync: (...args: unknown[]) => setStringAsync(...args),
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: (...args: unknown[]) => notificationAsync(...args),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  ActionSheetIOS: {
    showActionSheetWithOptions: (...args: unknown[]) => showActionSheetWithOptions(...args),
  },
}));

describe('performCopy', () => {
  beforeEach(() => {
    setStringAsync.mockReset();
    notificationAsync.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    showActionSheetWithOptions.mockReset();
  });

  it('writes to the clipboard, fires success haptic, and toasts success', async () => {
    setStringAsync.mockResolvedValue(undefined);
    const { performCopy } = await import('./use-message-copy');
    await performCopy('hello');
    expect(setStringAsync).toHaveBeenCalledWith('hello');
    expect(notificationAsync).toHaveBeenCalledWith('success');
    expect(toastSuccess).toHaveBeenCalledWith('Copied to clipboard');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts an error on clipboard failure and does not throw (sheet stays open)', async () => {
    setStringAsync.mockRejectedValue(new Error('denied'));
    const { performCopy } = await import('./use-message-copy');
    await expect(performCopy('hello')).resolves.toBeUndefined();
    expect(toastError).toHaveBeenCalledWith('Could not copy to clipboard');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(notificationAsync).not.toHaveBeenCalled();
  });
});
