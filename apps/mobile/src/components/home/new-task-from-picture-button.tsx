import { useCallback } from 'react';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { View } from 'react-native';

import { pickAgentPicture } from '@/components/agents/attachment-picker';
import { Button } from '@/components/ui/button';
import { Camera } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { stagePictureForNewSession } from '@/lib/agent-attachments/picture-entry';
import { useAndroidPendingPickerRecovery } from '@/lib/agent-attachments/use-android-pending-picker-recovery';
import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type NewTaskFromPictureButtonProps = {
  organizationId: string | null;
};

/**
 * Home entry point for a new task started from a picture. The source sheet
 * opens before any composer exists; a picture opens the ordinary new-agent
 * composer with it attached, and cancel (or a failed launch) leaves the person
 * on Home with nothing staged.
 */
export function NewTaskFromPictureButton({
  organizationId,
}: Readonly<NewTaskFromPictureButtonProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { showActionSheetWithOptions } = useActionSheet();
  const { userId } = useCurrentUserId();

  const openComposerWithPicture = useCallback(
    (candidates: AgentAttachmentCandidate[]) => {
      const href = stagePictureForNewSession({ candidates, organizationId });
      if (href !== null) {
        router.push(href as Href);
      }
    },
    [organizationId, router]
  );

  // Android can recreate the Activity while the camera or the picker is open,
  // so the result arrives through `getPendingResultAsync()` after the return
  // instead of from the launch promise. The recovered picture opens the same
  // composer a fresh pick does.
  const deliverRecovered = useCallback(
    async (candidates: AgentAttachmentCandidate[]) => {
      openComposerWithPicture(candidates);
      // The recovery hook awaits this before it can run again; the push above
      // is synchronous once the href is staged.
      await Promise.resolve();
    },
    [openComposerWithPicture]
  );
  useAndroidPendingPickerRecovery({
    surface: 'agent-picture',
    sessionId: null,
    addCandidates: deliverRecovered,
  });

  const handlePress = useCallback(() => {
    void (async () => {
      try {
        const candidates = await pickAgentPicture(showActionSheetWithOptions, {
          userId,
          surface: 'agent-picture',
          sessionId: null,
        });
        openComposerWithPicture(candidates);
      } catch {
        // `pickAgentPicture` resolves with no candidates on a cancel, a denied
        // permission, and a failed launch (the picker toasts that one). A
        // native rejection must still leave the person on Home with nothing
        // staged, able to tap again.
      }
    })();
  }, [openComposerWithPicture, showActionSheetWithOptions, userId]);

  return (
    <View className="mx-4">
      <Button variant="secondary" size="lg" className="w-full" onPress={handlePress}>
        <Camera size={18} color={colors.secondaryForeground} />
        <Text className="shrink text-center font-semibold">{t('home.newTaskFromPicture')}</Text>
      </Button>
    </View>
  );
}
