// Bottom-sheet picker for GitHub's 8 review-comment reactions.
// The native sheet (`@/components/ui/sheet`) isolates the background on both platforms and answers the Android back
// button, and it presents a separate native window so it also stacks above a
// formSheet route (a JS sheet or a portal overlay would render below it).
//
// The header is the shared sheet header, so the picker's title reads like every
// other sheet's and Close is the way out. Focus restore after the sheet closes
// belongs to the parent, which owns the trigger. Every close path here routes
// through `onClose` or `onPick`.

import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { SheetHeader } from '@/components/sheet-header';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
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

  const reacted = new Set<string>();
  for (const r of reactions) {
    if (r.viewerHasReacted) {
      reacted.add(r.content);
    }
  }

  return (
    // No snap points: the native sheet sizes to the emoji grid.
    <Sheet visible={visible} onClose={onClose}>
      {/* i18n-dup-ok: prReview.discussion.reaction* is a numeral count label
          ('3 reactions'); this key is the picker's title — cs/pl/uk differ. */}
      <SheetHeader
        title={t('common.reactions')}
        onDone={onClose}
        doneLabel={t('common.close')}
        topInset="never"
      />
      <View accessibilityViewIsModal className={cn(SCREEN_BODY_CLASS, 'pb-6')}>
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
    </Sheet>
  );
}
