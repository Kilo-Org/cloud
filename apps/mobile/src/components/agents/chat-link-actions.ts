import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { openExternalUrl } from '@/lib/external-link';

type ChatLinkAction = 'open' | 'copy' | 'share' | 'review-pr';

type ChatLinkActionOption = { kind: ChatLinkAction | 'cancel'; label: string };

export function buildChatLinkActionSheet({ isPrLink = false }: { isPrLink?: boolean } = {}) {
  const actions: ChatLinkActionOption[] = [
    ...(isPrLink
      ? ([{ kind: 'review-pr', label: i18n.t('agentChat.chatLink.reviewPr') }] as const)
      : []),
    { kind: 'open', label: i18n.t('agentChat.chatLink.openLink') },
    { kind: 'copy', label: i18n.t('agentChat.chatLink.copyLink') },
    { kind: 'share', label: i18n.t('agentChat.chatLink.shareLink') },
    { kind: 'cancel', label: i18n.t('common.cancel') },
  ];

  return {
    actions,
    options: actions.map(action => action.label),
    cancelButtonIndex: actions.length - 1,
  };
}

/**
 * The tap (not long-press) action sheet for a GitHub PR link. The accepted
 * contract is exactly four options: Review PR, Open in browser, Share, Cancel.
 * This is intentionally distinct from the long-press sheet, which also
 * offers Copy link.
 */
export function buildPrLinkTapActionSheet() {
  const actions: ChatLinkActionOption[] = [
    { kind: 'review-pr', label: i18n.t('agentChat.chatLink.reviewPr') },
    { kind: 'open', label: i18n.t('common.openInBrowser') },
    { kind: 'share', label: i18n.t('agentChat.chatLink.share') },
    { kind: 'cancel', label: i18n.t('common.cancel') },
  ];

  return {
    actions,
    options: actions.map(action => action.label),
    cancelButtonIndex: actions.length - 1,
  };
}

export function getSelectedChatLinkAction(
  sheet: ReturnType<typeof buildChatLinkActionSheet> | ReturnType<typeof buildPrLinkTapActionSheet>,
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
      label: i18n.t('common.tryAgain'),
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
      toast.success(i18n.t('agentChat.chatLink.linkCopied'));
    } catch {
      showRetryableError(i18n.t('agentChat.chatLink.couldNotCopyLink'), async () => {
        await performChatLinkAction('copy', href);
      });
    }
    return;
  }

  try {
    await Share.share({ message: href });
  } catch {
    showRetryableError(i18n.t('agentChat.chatLink.couldNotShareLink'), async () => {
      await performChatLinkAction('share', href);
    });
  }
}
