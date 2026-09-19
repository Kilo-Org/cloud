import { useActionSheet } from '@expo/react-native-action-sheet';
import { type Href, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { type GestureResponderEvent } from 'react-native';
import { useTranslation } from 'react-i18next';

import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';
import { useThemedActionSheetOptions } from '@/lib/hooks/use-themed-action-sheet';
import { openExternalUrl } from '@/lib/external-link';
import { providerPrRoutePath } from '@/lib/pr-review/provider-pr-ref';
import { parseProviderPrUrl } from '@/lib/pr-review/provider-pr-url';

import {
  buildChatLinkActionSheet,
  buildPrLinkTapActionSheet,
  getSelectedChatLinkAction,
  performChatLinkAction,
} from './chat-link-actions';
import { formatLinkHost } from './markdown-link-confirm';
import { MarkdownText, type MarkdownTextProps } from './markdown-text';
import { performCopy } from './use-message-copy';

type ChatMarkdownTextProps = Omit<
  MarkdownTextProps,
  'onLongPressLink' | 'onPressLink' | 'onCopyCode'
>;

/** Sheet message: host then full href, so the host is visible above the URL. */
function sheetMessage(href: string): string {
  const host = formatLinkHost(href);
  return host ? `${host}\n${href}` : href;
}

function buildPrReviewHref(href: string): Href | null {
  const ref = parseProviderPrUrl(href);
  return ref ? providerPrRoutePath(ref) : null;
}

export function ChatMarkdownText(props: Readonly<ChatMarkdownTextProps>) {
  const { showActionSheetWithOptions } = useActionSheet();
  const themedSheet = useThemedActionSheetOptions();
  const router = useRouter();
  const { t } = useTranslation();
  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);

  const handlePressLink = useCallback(
    (href: string) => {
      // When PR Review is off, PR links behave like any other link (default
      // open-in-browser) instead of showing the Review-PR tap sheet.
      if (!prReviewEnabled || !parseProviderPrUrl(href)) {
        return false;
      }
      // Tap on a PR link shows exactly four options: Review PR / Open in
      // browser / Share / Cancel.
      const sheet = buildPrLinkTapActionSheet();
      showActionSheetWithOptions(
        {
          options: sheet.options,
          cancelButtonIndex: sheet.cancelButtonIndex,
          title: t('agentChat.chatLink.prLinkActions'),
          message: sheetMessage(href),
          ...themedSheet,
        },
        index => {
          const action = getSelectedChatLinkAction(sheet, index);
          if (action === 'review-pr') {
            const reviewHref = buildPrReviewHref(href);
            if (reviewHref) {
              router.push(reviewHref);
            }
            return;
          }
          if (action === 'open') {
            void openExternalUrl(href, { retryOnError: true });
            return;
          }
          if (action === 'share') {
            void performChatLinkAction('share', href);
          }
        }
      );
      return true;
    },
    [prReviewEnabled, router, showActionSheetWithOptions, t, themedSheet]
  );

  const handleLongPressLink = useCallback(
    (href: string, event?: GestureResponderEvent) => {
      event?.stopPropagation();
      const isPrLink = prReviewEnabled && parseProviderPrUrl(href) !== null;
      const sheet = buildChatLinkActionSheet({ isPrLink });
      showActionSheetWithOptions(
        {
          options: sheet.options,
          cancelButtonIndex: sheet.cancelButtonIndex,
          title: t('agentChat.chatLink.linkActions'),
          message: sheetMessage(href),
          ...themedSheet,
        },
        index => {
          const action = getSelectedChatLinkAction(sheet, index);
          if (action === 'review-pr') {
            const reviewHref = buildPrReviewHref(href);
            if (reviewHref) {
              router.push(reviewHref);
            }
            return;
          }
          if (action) {
            void performChatLinkAction(action, href);
          }
        }
      );
    },
    [prReviewEnabled, router, showActionSheetWithOptions, t, themedSheet]
  );

  // Code fences in the transcript copy through the shared clipboard helper, so
  // success/failure feedback (haptic + toast) matches every other copy action.
  const handleCopyCode = useCallback((code: string) => {
    void performCopy(code);
  }, []);

  return (
    <MarkdownText
      {...props}
      onLongPressLink={handleLongPressLink}
      onPressLink={handlePressLink}
      onCopyCode={handleCopyCode}
    />
  );
}
