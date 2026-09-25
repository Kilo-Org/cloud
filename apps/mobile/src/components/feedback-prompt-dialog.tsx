import { useTranslation } from 'react-i18next';
import { Modal, Pressable, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { requestAppRating, sendAppFeedback } from '@/lib/feedback';

type FeedbackPromptDialogProps = {
  userId: string | undefined;
  onDismiss: () => void;
  /**
   * Called once the `Modal` reports it is shown (its `onShow`). The host uses
   * it to answer a pending request: only a shown dialog counts as presented.
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
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss} onShow={onShown}>
      <Pressable accessible={false} className="flex-1 justify-center px-6" onPress={onDismiss}>
        <View className="absolute inset-0 bg-black opacity-50" />
        <Pressable
          accessible={false}
          accessibilityViewIsModal
          className="gap-4 rounded-xl bg-card p-5"
          onPress={event => {
            event.stopPropagation();
          }}
        >
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
        </Pressable>
      </Pressable>
    </Modal>
  );
}
