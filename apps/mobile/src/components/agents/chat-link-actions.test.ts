import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner-native';

import { openExternalUrl } from '@/lib/external-link';

import {
  buildChatLinkActionSheet,
  getSelectedChatLinkAction,
  performChatLinkAction,
} from './chat-link-actions';

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('react-native', () => ({
  Share: { share: vi.fn(), dismissedAction: 'dismissedAction', sharedAction: 'sharedAction' },
}));
vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));

// Share.share is a jest/vitest mock function assigned via vi.mock above, not a bound instance method.
// eslint-disable-next-line typescript-eslint/unbound-method -- see above
const mockedShare = vi.mocked(Share.share);

describe('chat link actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('orders the approved actions and marks cancel', () => {
    const sheet = buildChatLinkActionSheet();

    expect(sheet.options).toEqual(['Open link', 'Copy link', 'Share link', 'Cancel']);
    expect(sheet.cancelButtonIndex).toBe(3);
    expect(getSelectedChatLinkAction(sheet, 0)).toBe('open');
    expect(getSelectedChatLinkAction(sheet, 1)).toBe('copy');
    expect(getSelectedChatLinkAction(sheet, 2)).toBe('share');
    expect(getSelectedChatLinkAction(sheet, 3)).toBeNull();
    expect(getSelectedChatLinkAction(sheet, undefined)).toBeNull();
  });

  it('opens the exact URL through the existing browser helper with retry enabled', async () => {
    await performChatLinkAction('open', 'https://kilo.ai/docs?source=chat#links');

    expect(openExternalUrl).toHaveBeenCalledWith('https://kilo.ai/docs?source=chat#links', {
      label: 'link',
      retryOnError: true,
    });
  });

  it('copies the exact URL and confirms success', async () => {
    vi.mocked(Clipboard.setStringAsync).mockResolvedValue(true);

    await performChatLinkAction('copy', 'https://kilo.ai/docs');

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('https://kilo.ai/docs');
    expect(toast.success).toHaveBeenCalledWith('Link copied');
  });

  it('retries only copying after a clipboard failure', async () => {
    vi.mocked(Clipboard.setStringAsync)
      .mockRejectedValueOnce(new Error('clipboard unavailable'))
      .mockResolvedValueOnce(true);

    await performChatLinkAction('copy', 'https://kilo.ai/docs');

    expect(toast.error).toHaveBeenCalledWith('Could not copy link', {
      action: { label: 'Try again', onClick: expect.any(Function) },
    });
    const options = vi.mocked(toast.error).mock.calls[0]?.[1];
    if (!options?.action || typeof options.action !== 'object' || !('onClick' in options.action)) {
      throw new Error('Expected retry action');
    }

    options.action.onClick();
    await vi.waitFor(() => {
      expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(2);
    });
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(mockedShare).not.toHaveBeenCalled();
  });

  it('treats a false clipboard result as a retryable failure', async () => {
    vi.mocked(Clipboard.setStringAsync).mockResolvedValue(false);

    await performChatLinkAction('copy', 'https://kilo.ai/docs');

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Could not copy link', {
      action: { label: 'Try again', onClick: expect.any(Function) },
    });
  });

  it('shares the exact URL without treating dismissal as failure', async () => {
    mockedShare.mockResolvedValue({ action: Share.dismissedAction });

    await performChatLinkAction('share', 'https://kilo.ai/docs');

    expect(mockedShare).toHaveBeenCalledWith({ message: 'https://kilo.ai/docs' });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('retries only sharing after a share failure', async () => {
    mockedShare
      .mockRejectedValueOnce(new Error('share unavailable'))
      .mockResolvedValueOnce({ action: Share.sharedAction });

    await performChatLinkAction('share', 'https://kilo.ai/docs');

    expect(toast.error).toHaveBeenCalledWith('Could not share link', {
      action: { label: 'Try again', onClick: expect.any(Function) },
    });
    const options = vi.mocked(toast.error).mock.calls[0]?.[1];
    if (!options?.action || typeof options.action !== 'object' || !('onClick' in options.action)) {
      throw new Error('Expected retry action');
    }

    options.action.onClick();
    await vi.waitFor(() => {
      expect(mockedShare).toHaveBeenCalledTimes(2);
    });
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  });
});
