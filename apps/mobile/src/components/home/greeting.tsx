import { i18n } from '@/i18n';

function timeOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour < 12) {
    return 'morning';
  }
  if (hour < 17) {
    return 'afternoon';
  }
  return 'evening';
}

const GREETING_KEYS = {
  morning: 'home.greetingMorning',
  afternoon: 'home.greetingAfternoon',
  evening: 'home.greetingEvening',
} as const;

export function buildTimedGreeting(): string {
  const period = timeOfDay(new Date().getHours());
  return i18n.t(GREETING_KEYS[period]);
}
