// Footer action bar rendered in-flow below the PR diff FlashList. The list
// ends at its top edge, so a diff row is never clipped by it at any scroll
// position (spot check e3: the bar floated over the list and cut the last
// src/beta.ts line). Hosts:
//   - The "Comment" affordance that pushes the comment-composer route
//     when a diff-line selection exists, plus a "Clear" button that
//     drops the selection.
//   - The "Finish review" button that pushes the review-submit route,
//     shown regardless of pending-comment count so a clean PR can still
//     be approved. The numeric count badge only renders when the queue
//     is non-empty.
//
// Extracted from `pr-diff-file-list.tsx` to keep that file under the
// 300-line repo cap.

import { type Href, useRouter } from 'expo-router';
import { MessageCirclePlus } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { providerPrSheetHref } from '@/components/pr-review/pr-review-provider-sheet-href';
import { clearDiffSelection } from '@/lib/pr-review/diff-selection-bridge';
import { type SelectionState } from '@/lib/pr-review/diff-selection';
import { type DiffViewMode } from '@/lib/pr-review/diff/pr-diff-list-items';
import { type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { usePendingReview } from '@/lib/pr-review/pending-review-provider';
import { cn } from '@/lib/utils';

const COMMENT_COMPOSER_PATH = '/(app)/pr-review/[owner]/[repo]/[number]/comment-composer' as const;
const REVIEW_SUBMIT_PATH = '/(app)/pr-review/[owner]/[repo]/[number]/review-submit' as const;

type PrDiffFloatingActionsProps = Readonly<{
  owner: string;
  repo: string;
  number: number;
  /**
   * The provider ref when the diff renders under a GitLab / Bitbucket scope
   * (s6). The two sheets are route siblings on every provider, so the bar
   * pushes the sheet inside the ref's own route — pushing the GitHub sibling
   * would leave the provider scope and write to the wrong provider.
   */
  prRef?: ProviderPrRef;
  /** Unified (default) or side-by-side (tablet only). */
  viewMode: DiffViewMode;
  /** `null` when no selection exists. Drives the "Comment" affordance. */
  selection: SelectionState | null;
  /** Setter for the parent's selection state — `null` clears. */
  onClearSelection: () => void;
}>;

export function PrDiffFloatingActions({
  owner,
  repo,
  number,
  prRef,
  viewMode,
  selection,
  onClearSelection,
}: PrDiffFloatingActionsProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const pending = usePendingReview();
  // The footer sits on the bottom edge, so its bottom padding must include
  // the Android system inset. The container is opaque (`bg-background`) and
  // in-flow: the diff list ends at its top edge, so no row is ever clipped
  // by it and nothing shows through around the card.
  const insets = useSafeAreaInsets();

  const showSelectionAction = viewMode === 'unified' && selection !== null;
  // P1-F-46b: the submit affordance must always be reachable from the
  // Files tab, even when the pending-comment queue is empty (clean
  // approve). The numeric count badge is only rendered when the queue
  // is non-empty (see below), so a "0" never shows.

  function openCommentComposer() {
    if (!selection) {
      return;
    }
    const lineParams = {
      path: selection.path,
      side: selection.side,
      line: selection.line,
      ...(selection.startLine !== selection.line ? { startLine: selection.startLine } : {}),
    };
    if (prRef) {
      router.push(providerPrSheetHref(prRef, 'comment-composer', lineParams));
      return;
    }
    const href: Href = {
      pathname: COMMENT_COMPOSER_PATH,
      // The bracketed GitHub pathname needs the route segments as params.
      params: { owner, repo, number, ...lineParams },
    };
    router.push(href);
  }

  function openReviewSubmit() {
    if (prRef) {
      router.push(providerPrSheetHref(prRef, 'review-submit'));
      return;
    }
    const href: Href = {
      pathname: REVIEW_SUBMIT_PATH,
      params: { owner, repo, number },
    };
    router.push(href);
  }

  return (
    <View
      className="w-full items-center gap-2 bg-background px-4 pt-3"
      style={{ paddingBottom: 24 + insets.bottom }}
    >
      <View className="w-full gap-2 rounded-2xl border border-border bg-background px-3 py-3 shadow-lg shadow-[#0000001A]">
        {showSelectionAction ? (
          <View className="flex-row items-center gap-2">
            <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
              {selectionDescription(selection)}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => {
                onClearSelection();
                clearDiffSelection({ owner, repo, number });
              }}
              accessibilityLabel={t('prReview.floatingActions.clearSelection')}
            >
              <Text>{t('prReview.floatingActions.clear')}</Text>
            </Button>
            <Button
              onPress={openCommentComposer}
              size="sm"
              accessibilityLabel={t('prReview.floatingActions.commentOnSelectedLines')}
            >
              <MessageCirclePlus size={14} color={colors.primaryForeground} />
              <Text>{t('prReview.floatingActions.comment')}</Text>
            </Button>
          </View>
        ) : null}
        <Button
          onPress={openReviewSubmit}
          accessibilityLabel={t('prReview.floatingActions.finishReview')}
          className={cn(showSelectionAction && 'mt-1')}
        >
          <View className="relative flex-row items-center">
            <Text>{t('prReview.floatingActions.finishReview')}</Text>
            {pending.items.length > 0 ? (
              <View className="absolute -right-2.5 -top-2.5 min-h-5 min-w-5 items-center justify-center rounded-full bg-primary-foreground px-1.5">
                <Text className="text-xs font-semibold text-primary">{pending.items.length}</Text>
              </View>
            ) : null}
          </View>
        </Button>
      </View>
    </View>
  );
}

function selectionDescription(selection: SelectionState): string {
  const range =
    selection.startLine === selection.line
      ? `L${selection.startLine}`
      : `L${selection.startLine}–L${selection.line}`;
  return `${selection.path} ${selection.side} ${range}`;
}
