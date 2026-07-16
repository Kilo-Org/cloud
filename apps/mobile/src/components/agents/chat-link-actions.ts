import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';
import { toast } from 'sonner-native';

import { openExternalUrl } from '@/lib/external-link';

type ChatLinkAction = 'open' | 'copy' | 'share';

type ChatLinkActionOption =
  | { kind: ChatLinkAction; label: string }
  | { kind: 'cancel'; label: 'Cancel' };

export function buildChatLinkActionSheet() {
  const actions: ChatLinkActionOption[] = [
    { kind: 'open', label: 'Open link' },
    { kind: 'copy', label: 'Copy link' },
    { kind: 'share', label: 'Share link' },
    { kind: 'cancel', label: 'Cancel' },
  ];

  return {
    actions,
    options: actions.map(action => action.label),
    cancelButtonIndex: actions.length - 1,
  };
}

export function getSelectedChatLinkAction(
  sheet: ReturnType<typeof buildChatLinkActionSheet>,
  index: number | undefined
): ChatLinkAction | null {
  if (index === undefined) {
    return null;
  }
  const action = sheet.actions[index];
  return action && action.kind !== 'cancel' ? action.kind : null;
}

function showRetryableError(message: string, retry: () => Promise<void>) {
  toast.error(message, {
    action: {
      label: 'Try again',
      onClick: () => {
        void retry();
      },
    },
  });
}

export async function performChatLinkAction(action: ChatLinkAction, href: string): Promise<void> {
  if (action === 'open') {
    await openExternalUrl(href, { label: 'link', retryOnError: true });
    return;
  }

  if (action === 'copy') {
    try {
      const copied = await Clipboard.setStringAsync(href);
      if (!copied) {
        throw new Error('Clipboard rejected link');
      }
      toast.success('Link copied');
    } catch {
      showRetryableError('Could not copy link', async () => {
        await performChatLinkAction('copy', href);
      });
    }
    return;
  }

  try {
    await Share.share({ message: href });
  } catch {
    showRetryableError('Could not share link', async () => {
      await performChatLinkAction('share', href);
    });
  }
}
