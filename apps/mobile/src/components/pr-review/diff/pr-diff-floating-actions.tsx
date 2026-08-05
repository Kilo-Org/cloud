// Floating action bar rendered over the PR diff FlashList. Hosts:
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
import { MessageCirclePlus } from 'lucide-react-native';
import { type LayoutChangeEvent, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { clearDiffSelection } from '@/lib/pr-review/diff-selection-bridge';
import { type SelectionState } from '@/lib/pr-review/diff-selection';
import { type DiffViewMode } from '@/lib/pr-review/diff/pr-diff-list-items';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { usePendingReview } from '@/lib/pr-review/pending-review-provider';
import { cn } from '@/lib/utils';

const COMMENT_COMPOSER_PATH = '/(app)/pr-review/[owner]/[repo]/[number]/comment-composer' as const;
const REVIEW_SUBMIT_PATH = '/(app)/pr-review/[owner]/[repo]/[number]/review-submit' as const;

type PrDiffFloatingActionsProps = Readonly<{
  owner: string;
  repo: string;
  number: number;
  /** Unified (default) or side-by-side (tablet only). */
  viewMode: DiffViewMode;
  /** `null` when no selection exists. Drives the "Comment" affordance. */
  selection: SelectionState | null;
  /** Setter for the parent's selection state — `null` clears. */
  onClearSelection: () => void;
  /** Optional callback for the measured root layout height (points). */
  onHeightChange?: (height: number) => void;
}>;

export function PrDiffFloatingActions({
  owner,
  repo,
  number,
  viewMode,
  selection,
  onClearSelection,
  onHeightChange,
}: PrDiffFloatingActionsProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const pending = usePendingReview();

  const showSelectionAction = viewMode === 'unified' && selection !== null;
  // P1-F-46b: the submit affordance must always be reachable from the
  // Files tab, even when the pending-comment queue is empty (clean
  // approve). The numeric count badge is only rendered when the queue
  // is non-empty (see below), so a "0" never shows.

  function openCommentComposer() {
    if (!selection) {
      return;
    }
    const href: Href = {
      pathname: COMMENT_COMPOSER_PATH,
      params: {
        owner,
        repo,
        number,
        path: selection.path,
        side: selection.side,
        line: selection.line,
        ...(selection.startLine !== selection.line ? { startLine: selection.startLine } : {}),
      },
    };
    router.push(href);
  }

  function openReviewSubmit() {
    const href: Href = {
      pathname: REVIEW_SUBMIT_PATH,
      params: { owner, repo, number },
    };
    router.push(href);
  }

  return (
    <View
      onLayout={(event: LayoutChangeEvent) => {
        onHeightChange?.(event.nativeEvent.layout.height);
      }}
      pointerEvents="box-none"
      className="absolute inset-x-0 bottom-0 items-center gap-2 px-4 pb-6 pt-3"
    >
      <View className="w-full gap-2 rounded-2xl border border-border bg-background px-3 py-3 shadow-lg shadow-black/10">
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
                clearDiffSelection();
              }}
              accessibilityLabel="Clear selection"
            >
              <Text>Clear</Text>
            </Button>
            <Button
              onPress={openCommentComposer}
              size="sm"
              accessibilityLabel="Comment on selected lines"
            >
              <MessageCirclePlus size={14} color={colors.primaryForeground} />
              <Text>Comment</Text>
            </Button>
          </View>
        ) : null}
        <Button
          onPress={openReviewSubmit}
          accessibilityLabel="Finish review"
          className={cn(showSelectionAction && 'mt-1')}
        >
          <View className="relative flex-row items-center">
            <Text>Finish review</Text>
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
