/**
 * Convert a 5-field cron expression into a human-readable description.
 * Best-effort — returns the raw cron for expressions it can't describe.
 */
export function describeCron(cron: string): string {
  if (!cron.trim()) return '';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minPart, hourPart, dayPart, monthPart, dowPart] = parts;

  // Every N minutes: */N * * * *
  if (
    minPart.startsWith('*/') &&
    hourPart === '*' &&
    dayPart === '*' &&
    monthPart === '*' &&
    dowPart === '*'
  ) {
    const n = parseInt(minPart.slice(2), 10);
    if (n === 1) return 'Every minute';
    return `Every ${n} minutes`;
  }

  // Hourly: N * * * *
  if (
    /^\d+$/.test(minPart) &&
    hourPart === '*' &&
    dayPart === '*' &&
    monthPart === '*' &&
    dowPart === '*'
  ) {
    const min = parseInt(minPart, 10);
    if (min === 0) return 'Every hour';
    return `Every hour at :${String(min).padStart(2, '0')}`;
  }

  // Need fixed minute + hour for the rest
  if (!/^\d+$/.test(minPart) || !/^\d+$/.test(hourPart)) return cron;
  const minute = parseInt(minPart, 10);
  const hour = parseInt(hourPart, 10);
  const timeStr = formatTime(hour, minute);

  // Monthly: M H D * *
  if (/^\d+$/.test(dayPart) && monthPart === '*' && dowPart === '*') {
    const day = parseInt(dayPart, 10);
    return `Monthly on the ${ordinal(day)} at ${timeStr}`;
  }

  if (dayPart !== '*' || monthPart !== '*') return cron;

  // Daily: M H * * *
  if (dowPart === '*') {
    return `Daily at ${timeStr}`;
  }

  // Weekdays: M H * * 1-5
  if (dowPart === '1-5') {
    return `Weekdays at ${timeStr}`;
  }

  // Specific days: M H * * 0,1,3
  if (/^[0-6](,[0-6])*$/.test(dowPart)) {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = dowPart
      .split(',')
      .map(Number)
      .map(d => dayNames[d]);
    if (days.length === 1) {
      return `Weekly on ${days[0]} at ${timeStr}`;
    }
    return `${days.join(', ')} at ${timeStr}`;
  }

  return cron;
}

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 || 12;
  const m = String(minute).padStart(2, '0');
  return `${h}:${m} ${period}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
