/** Stable display name shared by settings and session startup, independent of viewer timezone. */
export function environmentSnapshotName(capturedAt: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(capturedAt);
}
