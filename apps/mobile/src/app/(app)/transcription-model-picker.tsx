import { TranscriptionModelPickerSheet } from '@/components/transcription-model-picker-sheet';

/** Route shell for the transcription model picker: the sheet owns the flow and
 * writes the SecureStore-backed store directly, so no picker bridge is needed. */
export default function TranscriptionModelPickerScreen() {
  return <TranscriptionModelPickerSheet />;
}
