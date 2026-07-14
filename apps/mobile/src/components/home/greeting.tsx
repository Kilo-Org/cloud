function timeOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour < 12) {
    return 'morning';
  }
  if (hour < 17) {
    return 'afternoon';
  }
  return 'evening';
}

export function buildTimedGreeting(): string {
  const period = timeOfDay(new Date().getHours());
  return `Good ${period}`;
}
