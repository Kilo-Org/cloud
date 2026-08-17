// Bottom-sheet picker for GitHub's 8 review-comment reactions.
// Pattern-copied from kilo-chat's message-reaction-picker-sheet, then
// converted to a native transparent Modal (D5): the Modal isolates the
// background on both platforms, `onRequestClose` answers the Android back
// button, and `animationType="slide"` gives the sheet its motion. Letting the
// platform animate keeps `visible` the single source of truth — nothing here
// has to stay in sync with an animation duration.
//
// Focus restore after dismissal: `Modal.onDismiss` is iOS-only in React
// Native, so on Android a delayed callback fires instead. Both paths run
// through one guard so the parent's `onDismiss` handler fires exactly once,
// never while the native Modal is still presented.

import { X } from '@/components/ui/icons';
import { useCallback, useEffect, useRef } from 'react';
import { Modal, Platform, Pressable, type Text as RNText, View } from 'react-native';
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

// Android never fires `Modal.onDismiss` (iOS-only in React Native), so the
// focus-restore callback waits out the platform's own slide-out before the
// background accessibility tree is reachable again.
const ANDROID_DISMISS_SETTLE_MS = 300;

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
  const wasVisibleRef = useRef(visible);
  // Focus restore after dismissal: `Modal.onDismiss` fires on iOS only, so
  // Android relies on the delayed callback below. Both paths go through
  // `notifyDismissed`, whose guard lets the parent's focus handler run exactly
  // once per dismissal no matter which path wins.
  const dismissedRef = useRef(false);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  const notifyDismissed = useCallback(() => {
    if (dismissedRef.current) {
      return;
    }
    dismissedRef.current = true;
    onDismissRef.current?.();
  }, []);

  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (visible) {
      dismissedRef.current = false;
      return undefined;
    }
    if (!wasVisible || Platform.OS === 'ios') {
      // iOS gets the native `onDismiss`, so it needs no timer at all.
      return undefined;
    }
    const timer = setTimeout(notifyDismissed, ANDROID_DISMISS_SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [visible, notifyDismissed]);

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
      // Focus restore back to the trigger belongs to the parent via this
      // callback: it fires only after the native Modal is fully dismissed
      // (native on iOS, delayed post-close callback on Android), when the
      // background accessibility tree is reachable again.
      onDismiss={notifyDismissed}
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
