// Bottom-sheet picker for GitHub's 8 review-comment reactions.
// Pattern-copied from kilo-chat's message-reaction-picker-sheet, then
// converted to a native transparent Modal (D5): the Modal isolates the
// background on both platforms, `onRequestClose` answers the Android back
// button, and Reanimated keeps the fade/slide motion inside. A native Modal
// dismisses the moment `visible` flips, so the sheet owns presentation: it
// mounts the animated content on open (entering plays) and defers its own
// dismissal until the exiting animations finish.

import { X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, type Text as RNText, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
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

// The longest exiting animation is SlideOutDown (180ms); FadeOut (150ms)
// finishes earlier. Keep the native Modal presented a tick past it so both
// exits are fully visible before the Modal is dismissed.
const EXIT_ANIMATION_MS = 200;

type ReactionPickerSheetProps = {
  readonly visible: boolean;
  readonly reactions: readonly {
    readonly content: string;
    readonly count: number;
    readonly viewerHasReacted: boolean;
  }[];
  readonly onClose: () => void;
  readonly onPick: (content: ReviewReactionContent) => void;
  /** Called once the native Modal has fully dismissed (after the exit animations). */
  readonly onDismiss?: () => void;
};

export function ReactionPickerSheet({
  visible,
  reactions,
  onClose,
  onPick,
  onDismiss,
}: Readonly<ReactionPickerSheetProps>) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const titleRef = useRef<RNText | null>(null);
  // The native Modal and the Reanimated content are controlled separately:
  // opening mounts the content (entering animations play), closing unmounts
  // it first (exiting animations play) and only then dismisses the Modal.
  // `visible` stays the parent-owned source of truth on every close path.
  const [nativeVisible, setNativeVisible] = useState(false);
  const [contentVisible, setContentVisible] = useState(false);
  const wasVisibleRef = useRef(visible);

  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (visible) {
      setNativeVisible(true);
      setContentVisible(true);
      return undefined;
    }
    if (!wasVisible) {
      return undefined;
    }
    setContentVisible(false);
    const timer = setTimeout(() => {
      setNativeVisible(false);
    }, EXIT_ANIMATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [visible]);

  const reacted = new Set<string>();
  for (const r of reactions) {
    if (r.viewerHasReacted) {
      reacted.add(r.content);
    }
  }

  return (
    <Modal
      visible={nativeVisible}
      transparent
      animationType="none"
      // Best-effort focus after native presentation; moveA11yFocus is a no-op
      // when the title handle is not mounted yet, so no retry loop is needed.
      onShow={() => {
        moveA11yFocus(titleRef);
      }}
      // Focus restore back to the trigger belongs to the parent via this
      // callback: it fires only after the native Modal is fully dismissed,
      // when the background accessibility tree is reachable again.
      onDismiss={onDismiss}
      onRequestClose={onClose}
    >
      {contentVisible ? (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(150)}
          className="flex-1 justify-end bg-black/40"
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
          </Animated.View>
        </Animated.View>
      ) : null}
    </Modal>
  );
}
