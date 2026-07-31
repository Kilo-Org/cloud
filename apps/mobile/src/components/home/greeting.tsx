function timeOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour < 12) {
    return 'morning';
  }
  if (hour < 17) {
    return 'afternoon';
  }
  return 'evening';
}

export function buildTimedGreeting(displayName?: string | null): string {
  const period = timeOfDay(new Date().getHours());
  const firstName = displayName?.trim().split(/\s+/)[0] ?? '';
  return firstName ? `Good ${period}, ${firstName}` : `Good ${period}`;
}
