import { type useNativeAuth } from '@/lib/auth/use-native-auth';

export function canSubmitEmailCode(
  code: string,
  busy?: ReturnType<typeof useNativeAuth>['busy']
): boolean {
  return busy === undefined && /^\d{6}$/.test(code);
}
