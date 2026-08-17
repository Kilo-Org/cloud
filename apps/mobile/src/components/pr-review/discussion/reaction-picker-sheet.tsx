// Bottom-sheet picker for GitHub's 8 review-comment reactions.
// Pattern-copied from kilo-chat's message-reaction-picker-sheet, then
// converted to a native transparent Modal (D5): the Modal isolates the
// background on both platforms, `onRequestClose` answers the Android back
// button, and `animationType="slide"` gives the sheet its motion. Letting the
// platform animate keeps `visible` the single source of truth — nothing here
// has to stay in sync with an animation duration.
//
// Focus restore after the sheet closes belongs to the parent, which owns the
// trigger. Every close path here routes through `onClose` or `onPick`.

import { X } from '@/components/ui/icons';
import { useRef } from 'react';
import { Modal, Pressable, type Text as RNText, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { moveA11yFocus } from '@/lib/a11y/announce';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { REACTION_EMOJI, REACTION_LABEL } from '@/lib/pr-review/discussion/reaction-pills';
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
  const titleRef = useRef<RNText | null>(null);

  const reacted = new Set<string>();
  for (const r of reactions) {
    if (r.viewerHasReacted) {
      reacted.add(r.content);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      // Best-effort focus after native presentation; moveA11yFocus is a no-op
      // when the title handle is not mounted yet, so no retry loop is needed.
      onShow={() => {
        moveA11yFocus(titleRef);
      }}
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end bg-black/40">
        <Pressable className="flex-1" accessibilityLabel="Close reactions" onPress={onClose} />
        <View
          accessibilityViewIsModal
          className="gap-4 rounded-t-3xl bg-card px-5 pt-4"
          style={{ paddingBottom: insets.bottom + 24 }}
        >
          <View className="flex-row items-center justify-between">
            <Text
              ref={titleRef}
              accessibilityRole="header"
              className="text-base font-semibold text-foreground"
            >
              Reactions
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close reactions"
              className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
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
                  accessibilityLabel={REACTION_LABEL[content]}
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
      </View>
    </Modal>
  );
}
