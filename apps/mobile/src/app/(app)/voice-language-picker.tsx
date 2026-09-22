import { VoiceLanguagePickerSheet } from '@/components/voice-language-picker-sheet';

/** Route shell for the voice language picker: the sheet owns the flow and
 * writes the SecureStore-backed store directly, so no picker bridge is needed. */
export default function VoiceLanguagePickerScreen() {
  return <VoiceLanguagePickerSheet />;
}
