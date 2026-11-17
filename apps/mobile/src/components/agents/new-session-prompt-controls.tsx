import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ComposerPasteButton } from '@/components/agents/composer-paste-button';
import { type resolveNewSessionPromptControlState } from '@/components/agents/new-session-prompt-state';
import { Paperclip } from '@/components/ui/icons';
import { VoiceInputButton, VoiceInputStatus } from '@/components/voice-input-control';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { type useVoiceInput } from '@/lib/voice-input/use-voice-input';

type NewSessionPromptControlsProps = {
  control: ReturnType<typeof resolveNewSessionPromptControlState>;
  voiceInput: ReturnType<typeof useVoiceInput>;
  onAddAttachment: () => void;
  pasteClipboard: () => void;
  children?: ReactNode;
};

export function NewSessionPromptControls({
  control,
  voiceInput,
  onAddAttachment,
  pasteClipboard,
  children,
}: Readonly<NewSessionPromptControlsProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const paperclipDisabled = control.paperclipDisabled;

  function handlePaperclipPress() {
    onAddAttachment();
  }

  function handleVoiceToggle() {
    void voiceInput.toggle();
  }

  return (
    <View className="flex-row items-center justify-between pb-2">
      <View className="flex-row items-center gap-1">
        <Pressable
          onPress={handlePaperclipPress}
          disabled={paperclipDisabled}
          // The pressable's own box is what a control-size audit measures, and
          // `hitSlop` never moves that rect, so the target has to be the class:
          // the shared 48dp box clears the 44pt design target on its own.
          className={cn(
            ICON_TARGET_BOX_CLASS,
            'rounded-full active:opacity-70',
            paperclipDisabled && 'opacity-50'
          )}
          accessibilityRole="button"
          accessibilityLabel={t('agentChat.composer.addAttachment')}
          accessibilityState={{ disabled: paperclipDisabled }}
        >
          <Paperclip size={18} color={colors.mutedForeground} />
        </Pressable>
        {/* Follows the draft-mutation lock, not the paperclip: a full
            attachment list still allows a text paste. */}
        <ComposerPasteButton onPress={pasteClipboard} disabled={control.draftMutationLocked} />
      </View>
      <View className="h-9 flex-1 items-center justify-center overflow-hidden px-2">
        <VoiceInputStatus status={voiceInput.status} />
      </View>
      {children}
      <VoiceInputButton
        disabled={control.voiceDisabled}
        status={voiceInput.status}
        onPress={handleVoiceToggle}
      />
    </View>
  );
}
