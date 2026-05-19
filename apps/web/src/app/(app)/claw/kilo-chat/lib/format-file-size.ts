const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export function formatFileSize(bytes: number): string {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${Math.round(value)} ${UNITS[unitIndex]}`;
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${UNITS[unitIndex]}`;
}
