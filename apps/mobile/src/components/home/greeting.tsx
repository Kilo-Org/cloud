function timeOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour < 12) {
    return 'morning';
  }
  if (hour < 17) {
    return 'afternoon';
  }
  return 'evening';
}

export function buildTimedGreeting(firstName: string | null): string {
  const period = timeOfDay(new Date().getHours());
  return firstName ? `Good ${period}, ${firstName}` : `Good ${period}`;
}
