import { useCallback } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';

import { LanguagePickerSheet } from '@/components/language-picker-sheet';
import { clearLanguagePickerBridge, getLanguagePickerBridge } from '@/lib/picker-bridge';

export default function AuthLanguagePickerScreen() {
  const router = useRouter();
  const bridge = getLanguagePickerBridge();

  useFocusEffect(
    useCallback(
      () => () => {
        clearLanguagePickerBridge();
      },
      []
    )
  );

  return (
    <LanguagePickerSheet
      returnTarget="login"
      beforeReload={bridge?.beforeReload}
      onApplied={bridge?.onApplied}
      onClose={() => {
        router.back();
      }}
    />
  );
}
