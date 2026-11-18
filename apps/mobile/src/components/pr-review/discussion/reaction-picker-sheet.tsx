// Bottom-sheet picker for GitHub's 8 review-comment reactions.
// The native sheet (`@/components/ui/sheet`) isolates the background on both platforms and answers the Android back
// button, and it presents a separate native window so it also stacks above a
// formSheet route (a JS sheet or a portal overlay would render below it).
//
// The header is the shared sheet header, so the picker's title reads like every
// other sheet's and Close is the way out. Opening the sheet moves assistive
// focus to that title (Android's focus event): a separate native window has no
// entry focus of its own, so a screen reader would otherwise stay on the list
// behind it. Focus restore after the sheet closes belongs to the parent, which
// owns the trigger. Every close path here routes through `onClose` or `onPick`.

import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, type TextInstance, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetHeader } from '@/components/sheet-header';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { requestA11yFocus } from '@/lib/a11y/announce';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
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
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const titleRef = useRef<TextInstance | null>(null);
  // The latch records a dispatched request, not delivered focus: Android
  // reports no outcome. Reaching the title is retried from the two real
  // signals — the open render (a reopened sheet keeps its title mounted) and
  // the body's layout, which arrives once the native window is presented and
  // can accept focus.
  const titleFocusRequestedRef = useRef(false);
  const focusTitle = useCallback(() => {
    if (titleFocusRequestedRef.current) {
      return;
    }
    if (requestA11yFocus(titleRef)) {
      titleFocusRequestedRef.current = true;
    }
  }, []);
  useEffect(() => {
    if (!visible) {
      titleFocusRequestedRef.current = false;
      return;
    }
    // A first presentation mounts the title a render after `visible` flips, so
    // there is nothing to focus yet; the body's layout below is that signal.
    // A reopen keeps the title mounted, which is the earlier signal.
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
    // No snap points: the native sheet sizes to the emoji grid. The modal
    // wrapper covers the header too: a screen reader must not reach the
    // comment list behind a separate native window. The bottom inset rides on
    // that wrapper and the 24pt floor is the body's own scale class, so the
    // sheet clears the home indicator without a literal in the style.
    <Sheet visible={visible} onClose={onClose}>
      <View
        accessibilityViewIsModal
        style={insets.bottom > 0 ? { paddingBottom: insets.bottom } : undefined}
      >
        {/* i18n-dup-ok: prReview.discussion.reaction* is a numeral count label
            ('3 reactions'); this key is the picker's title — cs/pl/uk differ. */}
        {/* The native handle already leaves the room above the title, so the
            header takes the shared under-handle pair instead of its own top
            padding. */}
        <SheetHeader
          title={t('common.reactions')}
          onDone={onClose}
          // Same accessible name the picker's own header gave its close control.
          doneLabel={t('common.closeReactions')}
          topInset="never"
          underHandle
          titleRef={titleRef}
        />
        <View onLayout={focusTitle} className={cn(SCREEN_BODY_CLASS, 'pb-6')}>
          <View className="flex-row flex-wrap gap-2">
            {REVIEW_REACTION_CONTENTS.map(content => {
              const isReacted = reacted.has(content);
              return (
                <Pressable
                  key={content}
                  accessibilityRole="button"
                  accessibilityLabel={reactionLabel(content)}
                  className={cn(
                    ICON_TARGET_BOX_CLASS,
                    'rounded-full active:opacity-75',
                    isReacted ? 'bg-accent-soft' : 'bg-muted'
                  )}
                  onPress={() => {
                    onPick(content);
                  }}
                >
                  <Text className="text-lg">{REACTION_EMOJI[content]}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Sheet>
  );
}
