import { type BusyAction } from '@/lib/auth/use-native-auth';
import { foldDecimalDigits } from '@/lib/format';

export function canSubmitEmailCode(code: string, busy?: BusyAction): boolean {
  return busy === undefined && /^\d{6}$/.test(foldDecimalDigits(code));
}
