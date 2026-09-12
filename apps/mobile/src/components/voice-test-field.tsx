import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { VoiceInputButton, VoiceInputStatus } from '@/components/voice-input-control';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { applyVoiceDraftToInput } from '@/lib/voice-input/voice-input-draft';
import { useVoiceInput } from '@/lib/voice-input/use-voice-input';

/**
 * Requirement 3 surface: a free-text area in voice settings that shows the
 * live effect of the current configuration. Interim and final transcripts —
 * gateway streaming segments and OS interim results alike — arrive through
 * `onDraftChange`, so the user can confirm the chosen language and model
 * without leaving the screen.
 *
 * The input stays uncontrolled on iOS (AGENTS.md): text lives in `textRef`,
 * `hasText` only drives the Clear affordance, and every speech write goes
 * through `applyVoiceDraftToInput`. Feedback for a failed or refused start
 * stays in the shared voice stack, so this field renders no error copy of its
 * own and its height never changes with the session state.
 */
export function VoiceTestField(): React.ReactElement {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const inputRef = useRef<TextInput>(null);
  const textRef = useRef('');
  const [hasText, setHasText] = useState(false);

  const handleTextChange = (text: string) => {
    textRef.current = text;
    setHasText(text.length > 0);
  };

  const voice = useVoiceInput({
    disabled: false,
    getDraft: () => textRef.current,
    onDraftChange: draft => {
      applyVoiceDraftToInput({ draft, input: inputRef.current, onChangeText: handleTextChange });
    },
  });

  const handleClear = () => {
    if (voice.isActive) {
      void voice.abort();
    }
    inputRef.current?.setNativeProps({ text: '' });
    handleTextChange('');
  };

  // Rendered disabled rather than hidden: the control row keeps its height
  // while there is nothing to clear, so starting a session never shifts it.
  const clearDisabled = !hasText && !voice.isActive;

  return (
    <View className="gap-2 rounded-lg bg-secondary px-3 py-3">
      <Text className="text-sm font-medium text-foreground">{t('voiceInput.testTitle')}</Text>
      <TextInput
        ref={inputRef}
        className="min-h-24 rounded-md border border-input bg-background px-3 py-2 text-base leading-6 text-foreground"
        defaultValue=""
        multiline
        onChangeText={handleTextChange}
        placeholder={t('voiceInput.testPlaceholder')}
        placeholderTextColor={colors.mutedForeground}
        textAlignVertical="top"
      />
      <View className="flex-row items-center gap-3">
        <VoiceInputButton
          disabled={!voice.available}
          onPress={() => void voice.toggle()}
          size="md"
          status={voice.status}
        />
        <VoiceInputStatus status={voice.status} />
        <Pressable
          accessibilityLabel={t('voiceInput.testClear')}
          accessibilityRole="button"
          // 44pt effective target (DESIGN.md): the compact text label sits in a
          // min-h-11/min-w-11 centered box, so the target never shrinks with the
          // label. disabled:opacity-50 separates the inert state from the live one.
          className="ml-auto min-h-11 min-w-11 items-center justify-center px-2 active:opacity-70 disabled:opacity-50"
          disabled={clearDisabled}
          onPress={handleClear}
        >
          <Text className="text-sm text-muted-foreground">{t('voiceInput.testClear')}</Text>
        </Pressable>
      </View>
    </View>
  );
}
