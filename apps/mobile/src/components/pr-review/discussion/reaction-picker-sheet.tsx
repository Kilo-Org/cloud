// Bottom-sheet picker for GitHub's 8 review-comment reactions.
// Pattern-copied from kilo-chat's message-reaction-picker-sheet, then
// converted to the app's native sheet (`@/components/ui/sheet`): the native
// sheet isolates the background on both platforms and answers the Android back
// button, and it presents a separate native window so it also stacks above a
// formSheet route (a JS sheet or a portal overlay would render below it).
//
// Focus restore after the sheet closes belongs to the parent, which owns the
// trigger. Every close path here routes through `onClose` or `onPick`.

import { X } from '@/components/ui/icons';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, type Text as RNText, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { moveA11yFocus } from '@/lib/a11y/announce';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { REACTION_EMOJI, reactionLabel } from '@/lib/pr-review/discussion/reaction-pills';
import {
  REVIEW_REACTION_CONTENTS,
  type ReviewReactionContent,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { cn } from '@/lib/utils';

type ReactionPickerSheetProps = {
  readonly visible: boolean;
  readonly reactions: readonly {
    readonly content: string;
    readonly count: number;
    readonly viewerHasReacted: boolean;
  }[];
  readonly onClose: () => void;
  readonly onPick: (content: ReviewReactionContent) => void;
};

export function ReactionPickerSheet({
  visible,
  reactions,
  onClose,
  onPick,
}: Readonly<ReactionPickerSheetProps>) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const titleRef = useRef<RNText | null>(null);
  // Latch only when the move actually happened: on Android the title's first
  // layout can arrive before its ref is attached, so the attempt resolves no
  // handle, returns false, and a later signal has to retry.
  const titleFocusedRef = useRef(false);
  const titleLaidOutRef = useRef(false);
  const focusTitle = useCallback(() => {
    if (titleFocusedRef.current) {
      return;
    }
    if (moveA11yFocus(titleRef)) {
      titleFocusedRef.current = true;
    }
  }, []);
  const attachTitle = useCallback(
    (node: RNText | null) => {
      titleRef.current = node;
      if (node !== null && titleLaidOutRef.current) {
        focusTitle();
      }
    },
    [focusTitle]
  );
  const handleTitleLayout = useCallback(() => {
    titleLaidOutRef.current = true;
    focusTitle();
  }, [focusTitle]);

  // Focus the picker's title once per presentation, when the move can actually
  // land. `Sheet` returns null on the commit that flips `visible`, so the title
  // mounts a render later; on Android its `onLayout` can even arrive before the
  // ref is attached. Reaching the title is retried from each real signal — this
  // effect for a reopen that never unmounted the title, `handleTitleLayout` and
  // `attachTitle` otherwise — and the guard latches only on a successful move.
  useEffect(() => {
    if (!visible) {
      titleFocusedRef.current = false;
      titleLaidOutRef.current = false;
      return;
    }
    if (titleRef.current !== null) {
      focusTitle();
    }
  }, [visible, focusTitle]);

  const reacted = new Set<string>();
  for (const r of reactions) {
    if (r.viewerHasReacted) {
      reacted.add(r.content);
    }
  }

  return (
    // No snap points: the native sheet sizes to the emoji grid.
    <Sheet visible={visible} onClose={onClose}>
      <View
        accessibilityViewIsModal
        className="gap-4 px-5 pt-4"
        style={{ paddingBottom: insets.bottom + 24 }}
      >
        <View className="flex-row items-center">
          <View className="size-[48px] shrink-0" />
          <Text
            ref={attachTitle}
            onLayout={handleTitleLayout}
            accessibilityRole="header"
            className="min-w-0 flex-1 text-center text-base font-semibold text-foreground"
          >
            {/* i18n-dup-ok: prReview.discussion.reaction* is a numeral count label
                ('3 reactions'); this key is the picker's title — cs/pl/uk differ. */}
            {t('common.reactions')}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.closeReactions')}
            className="size-[48px] shrink-0 items-center justify-center rounded-full active:bg-muted"
            onPress={onClose}
          >
            <X size={18} color={colors.foreground} />
          </Pressable>
        </View>
        <View className="flex-row flex-wrap gap-2">
          {REVIEW_REACTION_CONTENTS.map(content => {
            const isReacted = reacted.has(content);
            return (
              <Pressable
                key={content}
                accessibilityRole="button"
                accessibilityLabel={reactionLabel(content)}
                className={cn(
                  'h-[48px] w-[48px] items-center justify-center rounded-full active:opacity-75',
                  isReacted ? 'bg-accent-soft' : 'bg-muted'
                )}
                onPress={() => {
                  onPick(content);
                }}
              >
                <Text className="text-xl">{REACTION_EMOJI[content]}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </Sheet>
  );
}
