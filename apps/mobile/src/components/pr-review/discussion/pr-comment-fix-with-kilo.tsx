// "Fix with Kilo" on one PR/MR comment row: hands the comment link to a fresh
// agent session.
//
// The provider ref comes from the live scope, so the link names the surface
// the row is actually on: the GitHub route supplies the synthesized triple
// and a null organization, the provider layout supplies the GitLab/Bitbucket
// ref plus its organization. A comment with no addressable provider URL (a
// GitLab MR deep-linked with no instance hint) renders NOTHING — the row
// shows no CTA rather than a dead or failing one, the same rule the reactions
// capability gate (`comment-row.tsx`) follows.
//
// The press is pure navigation: stage the pre-written message in the share
// payload and push the new-session route. No I/O, no mutation, so there is
// nothing to retry, no failure state to render, and the control is never
// disabled. Static chrome: no async content renders here, so no skeleton and
// no layout shift.

import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable } from 'react-native';

import { WandSparkles } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { FIX_WITH_KILO_HIT_SLOP } from '@/lib/pr-review/comment-trailing-controls';
import {
  buildFixWithKiloHref,
  fixWithKiloMessage,
  fixWithKiloPrefillRepo,
  type PrCommentKind,
  prCommentWebUrl,
} from '@/lib/pr-review/fix-with-kilo';
import { useProviderPrScope } from '@/lib/pr-review/provider-pr-ref';
import { putSharePayload } from '@/lib/share-payload';

// The pill's hit slop lives with the trailing-group gap in
// comment-trailing-controls.ts: the pill's 2pt horizontal cap plus the
// overflow button's 3pt left slop stay inside the group's 10.5pt `gap-3`.

type PrCommentFixWithKiloProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly commentId: number;
  /** Where the comment lives on the provider's page (s1 anchor vocabulary). */
  readonly kind: PrCommentKind;
};

export function PrCommentFixWithKilo({
  owner,
  repo,
  number,
  commentId,
  kind,
}: Readonly<PrCommentFixWithKiloProps>) {
  const scope = useProviderPrScope({ owner, repo, number });
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();

  const commentUrl = prCommentWebUrl(scope.ref, kind, commentId);
  if (commentUrl === null) {
    return null;
  }

  const onPress = () => {
    const shareId = putSharePayload({
      text: fixWithKiloMessage(commentUrl),
      files: [],
      failedFiles: [],
    });
    router.push(
      buildFixWithKiloHref({
        shareId,
        organizationId: scope.organizationId,
        repo: fixWithKiloPrefillRepo(scope.ref),
      })
    );
  };

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('prReview.discussion.fixWithKilo')}
      hitSlop={FIX_WITH_KILO_HIT_SLOP}
      className="flex-row items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 active:opacity-70"
    >
      <WandSparkles size={14} color={colors.mutedForeground} />
      <Text className="text-xs font-medium text-foreground">
        {t('prReview.discussion.fixWithKilo')}
      </Text>
    </Pressable>
  );
}
