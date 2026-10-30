const formatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export function formatConnectTime(isoTimestamp: string): string {
  return formatter.format(new Date(isoTimestamp));
}
