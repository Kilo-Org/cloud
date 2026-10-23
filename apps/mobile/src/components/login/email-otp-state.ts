import { type useNativeAuth } from '@/lib/auth/use-native-auth';
import { foldDecimalDigits } from '@/lib/format';

export function canSubmitEmailCode(
  code: string,
  busy?: ReturnType<typeof useNativeAuth>['busy']
): boolean {
  return busy === undefined && /^\d{6}$/.test(foldDecimalDigits(code));
}
