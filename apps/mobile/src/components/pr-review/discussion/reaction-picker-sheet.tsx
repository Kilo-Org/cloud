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
import { useEffect, useRef } from 'react';
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

  // Best-effort focus once the rows are mounted; moveA11yFocus is a no-op when
  // the title handle is not mounted yet, so no retry loop is needed.
  useEffect(() => {
    if (visible) {
      moveA11yFocus(titleRef);
    }
  }, [visible]);

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
          <View className="size-11 shrink-0" />
          <Text
            ref={titleRef}
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
            className="size-11 shrink-0 items-center justify-center rounded-full active:bg-muted"
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
                  'h-11 w-11 items-center justify-center rounded-full active:opacity-75',
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
