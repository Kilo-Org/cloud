import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ComposerPasteButton } from '@/components/agents/composer-paste-button';
import { type resolveNewSessionPromptControlState } from '@/components/agents/new-session-prompt-state';
import { Paperclip } from '@/components/ui/icons';
import { VoiceInputButton, VoiceInputStatus } from '@/components/voice-input-control';
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
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          className={cn(
            'h-9 w-9 items-center justify-center rounded-full active:opacity-70',
            paperclipDisabled && 'opacity-50'
          )}
          accessibilityRole="button"
          accessibilityLabel={t('agentChat.composer.addAttachment')}
          accessibilityState={{ disabled: paperclipDisabled }}
        >
          <Paperclip size={18} color={colors.mutedForeground} />
        </Pressable>
        {/* Follows the input, not the paperclip: a full attachment list
            still allows a text paste. */}
        <ComposerPasteButton onPress={pasteClipboard} disabled={!control.inputEditable} />
      </View>
      {voiceInput.available ? (
        <View className="h-9 flex-1 items-center justify-center overflow-hidden px-2">
          <VoiceInputStatus status={voiceInput.status} />
        </View>
      ) : null}
      {children}
      {voiceInput.available ? (
        <VoiceInputButton
          disabled={control.voiceDisabled}
          size="lg"
          status={voiceInput.status}
          onPress={handleVoiceToggle}
        />
      ) : null}
    </View>
  );
}
