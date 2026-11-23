import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * Shown while the agent waits on a question this app cannot show. The request
 * payload could not be read, or it carried no questions, so no answer card is
 * drawn; the CLI can still answer the request, so the notice points the user
 * there instead of leaving the run stalled without explanation.
 *
 * `inset` is the notice's own horizontal margin inside a surface that does not
 * pad its content. Pass `false` from a container that already insets its
 * children, so the notice lines up with the cards beside it instead of sitting
 * one step further in.
 *
 * This component is presentation only: its polite live region is how Android
 * reads it, while `UnreadableRequestNotices` owns the single iOS announcement
 * covering every notice the session shows.
 *
 * The body reads at the same size as the copy beside it and takes the standard
 * ink: the warning amber marks the title, while the muted neutral and the amber
 * both fail body-text contrast on the warning tint.
 */
export function QuestionUnreadableNotice({ inset = true }: { inset?: boolean }) {
  const { t } = useTranslation();

  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      className={cn(
        'my-2 rounded-xl border border-warn-tile-border bg-warn-tile-bg p-4',
        inset && 'mx-4'
      )}
    >
      <Text className="text-base font-medium text-warn">
        {t('agentChat.questionCard.unreadableTitle')}
      </Text>
      <Text className="mt-1 text-base text-foreground">
        {t('agentChat.questionCard.unreadableBody')}
      </Text>
    </View>
  );
}
