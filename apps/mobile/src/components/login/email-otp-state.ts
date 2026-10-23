import { type useNativeAuth } from '@/lib/auth/use-native-auth';
import { toAsciiDigits } from '@/lib/format';

export function canSubmitEmailCode(
  code: string,
  locale: string,
  busy?: ReturnType<typeof useNativeAuth>['busy']
): boolean {
  return busy === undefined && /^\d{6}$/.test(toAsciiDigits(code, locale));
}
