import { useActionSheet } from '@expo/react-native-action-sheet';
import { type Href, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { type GestureResponderEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';
import { openExternalUrl } from '@/lib/external-link';
import { parseGitHubPrUrl } from '@/lib/github-pr-url';

import {
  buildChatLinkActionSheet,
  buildPrLinkTapActionSheet,
  getSelectedChatLinkAction,
  performChatLinkAction,
} from './chat-link-actions';
import { formatLinkHost } from './markdown-link-confirm';
import { MarkdownText, type MarkdownTextProps } from './markdown-text';

type ChatMarkdownTextProps = Omit<MarkdownTextProps, 'onLongPressLink' | 'onPressLink'>;

/** Sheet message: host then full href, so the host is visible above the URL. */
function sheetMessage(href: string): string {
  const host = formatLinkHost(href);
  return host ? `${host}\n${href}` : href;
}

function buildPrReviewHref(href: string): Href | null {
  const parsed = parseGitHubPrUrl(href);
  if (!parsed) {
    return null;
  }
  return {
    pathname: '/(app)/pr-review/[owner]/[repo]/[number]',
    params: {
      owner: parsed.owner,
      repo: parsed.repo,
      number: String(parsed.number),
    },
  };
}

export function ChatMarkdownText(props: Readonly<ChatMarkdownTextProps>) {
  const { showActionSheetWithOptions } = useActionSheet();
  const { bottom } = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useTranslation();
  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);

  const handlePressLink = useCallback(
    (href: string) => {
      // When PR Review is off, PR links behave like any other link (default
      // open-in-browser) instead of showing the Review-PR tap sheet.
      if (!prReviewEnabled || !parseGitHubPrUrl(href)) {
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
          containerStyle: { paddingBottom: bottom },
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
            void openExternalUrl(href, { label: 'link' });
            return;
          }
          if (action === 'share') {
            void performChatLinkAction('share', href);
          }
        }
      );
      return true;
    },
    [bottom, prReviewEnabled, router, showActionSheetWithOptions, t]
  );

  const handleLongPressLink = useCallback(
    (href: string, event?: GestureResponderEvent) => {
      event?.stopPropagation();
      const isPrLink = prReviewEnabled && parseGitHubPrUrl(href) !== null;
      const sheet = buildChatLinkActionSheet({ isPrLink });
      showActionSheetWithOptions(
        {
          options: sheet.options,
          cancelButtonIndex: sheet.cancelButtonIndex,
          title: t('agentChat.chatLink.linkActions'),
          message: sheetMessage(href),
          containerStyle: { paddingBottom: bottom },
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
    [bottom, prReviewEnabled, router, showActionSheetWithOptions, t]
  );

  return (
    <MarkdownText {...props} onLongPressLink={handleLongPressLink} onPressLink={handlePressLink} />
  );
}
