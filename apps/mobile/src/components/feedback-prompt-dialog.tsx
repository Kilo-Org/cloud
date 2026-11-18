import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import { requestAppRating, sendAppFeedback } from '@/lib/feedback';

type FeedbackPromptDialogProps = {
  userId: string | undefined;
  onDismiss: () => void;
  /**
   * Called once the dialog is on screen. The host uses it to answer a pending
   * request: only a shown dialog counts as presented.
   */
  onShown?: () => void;
};

/**
 * In-app feedback prompt for Android (see `feedback-prompt-platform.ts`): the
 * native Android alert reserves the empty message band between its title and
 * its actions, so the three choices float apart with the panel mostly void. The
 * in-app dialog lays the title out against the actions instead, and carries the
 * app's own card and button styling while it does.
 *
 * Mount it only while it should be open (e.g. `{open && <FeedbackPromptDialog ... />}`),
 * the same lifecycle `DestructiveConfirmDialog` uses.
 */
export function FeedbackPromptDialog({
  userId,
  onDismiss,
  onShown,
}: Readonly<FeedbackPromptDialogProps>) {
  const { t } = useTranslation();

  // A portal dialog paints in the commit that mounts it, so the effect that
  // follows that commit is the "shown" signal the host waits on.
  useEffect(() => {
    onShown?.();
  }, [onShown]);

  return (
    <DialogCard onClose={onDismiss}>
      <Text accessibilityRole="header" className="text-base font-semibold">
        {t('feedback.neutralTitle')}
      </Text>
      <View className="gap-2">
        <Button
          onPress={() => {
            onDismiss();
            requestAppRating();
          }}
        >
          <Text>{t('feedback.rateTheApp')}</Text>
        </Button>
        <Button
          variant="outline"
          onPress={() => {
            onDismiss();
            sendAppFeedback(userId);
          }}
        >
          <Text>{t('feedback.sendFeedback')}</Text>
        </Button>
        <Button variant="ghost" onPress={onDismiss}>
          <Text>{t('common.notNow')}</Text>
        </Button>
      </View>
    </DialogCard>
  );
}
