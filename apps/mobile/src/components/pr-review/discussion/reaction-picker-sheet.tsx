// Bottom-sheet picker for GitHub's 8 review-comment reactions.
// Pattern-copied from kilo-chat's message-reaction-picker-sheet
// (Portal + backdrop fade + slide-up card + Android BackHandler).
// Portal name is unique so chat and PR-review sheets never clobber
// each other when both trees mount.

import { Portal } from '@rn-primitives/portal';
import { X } from 'lucide-react-native';
import { useEffect } from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
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

  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [visible, onClose]);

  if (!visible) {
    return null;
  }

  const reacted = new Set<string>();
  for (const r of reactions) {
    if (r.viewerHasReacted) {
      reacted.add(r.content);
    }
  }

  return (
    <Portal name="pr-review-reactions">
      <Animated.View
        entering={FadeIn.duration(150)}
        exiting={FadeOut.duration(150)}
        className="absolute inset-0 justify-end bg-black/40"
      >
        <Pressable className="flex-1" accessibilityLabel="Close reactions" onPress={onClose} />
        <Animated.View
          entering={SlideInDown.duration(220)}
          exiting={SlideOutDown.duration(180)}
          accessibilityViewIsModal
          className="gap-4 rounded-t-3xl bg-card px-5 pt-4"
          style={{ paddingBottom: insets.bottom + 24 }}
        >
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-semibold text-foreground">Reactions</Text>
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
        </Animated.View>
      </Animated.View>
    </Portal>
  );
}
