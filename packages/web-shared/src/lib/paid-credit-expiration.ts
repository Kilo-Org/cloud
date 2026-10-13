import { dayjs } from '@kilocode/web-shared/lib/kilo-pass/dayjs';

export function paidCreditExpiration(issuedAt: Date = new Date()): Date {
  return dayjs(issuedAt).utc().add(1, 'year').toDate();
}
