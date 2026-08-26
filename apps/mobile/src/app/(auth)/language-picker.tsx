import { useCallback } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import { LanguagePickerSheet } from '@/components/language-picker-sheet';
import { type LanguageReturnTarget } from '@/i18n/return-target';
import { clearLanguagePickerBridge, getLanguagePickerBridge } from '@/lib/picker-bridge';

export default function AuthLanguagePickerScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ returnTarget?: string }>();
  const rawReturnTarget = Array.isArray(params.returnTarget)
    ? params.returnTarget[0]
    : params.returnTarget;
  const returnTarget: LanguageReturnTarget =
    rawReturnTarget === 'login' ||
    rawReturnTarget === 'profile' ||
    rawReturnTarget === 'preferences'
      ? rawReturnTarget
      : 'login';
  const bridge = getLanguagePickerBridge();

  useFocusEffect(
    useCallback(() => {
      return () => {
        clearLanguagePickerBridge();
      };
    }, [])
  );

  return (
    <LanguagePickerSheet
      returnTarget={returnTarget}
      beforeReload={bridge?.beforeReload}
      onApplied={bridge?.onApplied}
      onClose={() => {
        router.back();
      }}
    />
  );
}
