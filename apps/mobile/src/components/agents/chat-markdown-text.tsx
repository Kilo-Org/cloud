import { useActionSheet } from '@expo/react-native-action-sheet';
import { type Href, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { type GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { openExternalUrl } from '@/lib/external-link';
import { parseGitHubPrUrl } from '@/lib/github-pr-url';

import {
  buildChatLinkActionSheet,
  buildPrLinkTapActionSheet,
  getSelectedChatLinkAction,
  performChatLinkAction,
} from './chat-link-actions';
import { MarkdownText, type MarkdownTextProps } from './markdown-text';

type ChatMarkdownTextProps = Omit<MarkdownTextProps, 'onLongPressLink' | 'onPressLink'>;

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

  const handlePressLink = useCallback(
    (href: string) => {
      if (!parseGitHubPrUrl(href)) {
        return false;
      }
      // Tap on a PR link shows exactly three options: Review PR / Open in
      // browser / Cancel. The richer Copy/Share sheet is long-press only.
      const sheet = buildPrLinkTapActionSheet();
      showActionSheetWithOptions(
        {
          options: sheet.options,
          cancelButtonIndex: sheet.cancelButtonIndex,
          title: 'PR link actions',
          message: href,
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
          }
        }
      );
      return true;
    },
    [bottom, router, showActionSheetWithOptions]
  );

  const handleLongPressLink = useCallback(
    (href: string, event?: GestureResponderEvent) => {
      event?.stopPropagation();
      const isPrLink = parseGitHubPrUrl(href) !== null;
      const sheet = buildChatLinkActionSheet({ isPrLink });
      showActionSheetWithOptions(
        {
          options: sheet.options,
          cancelButtonIndex: sheet.cancelButtonIndex,
          title: 'Link actions',
          message: href,
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
    [bottom, router, showActionSheetWithOptions]
  );

  return (
    <MarkdownText {...props} onLongPressLink={handleLongPressLink} onPressLink={handlePressLink} />
  );
}
