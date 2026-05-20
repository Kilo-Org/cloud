const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export function formatFileSize(bytes: number): string {
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < FILE_SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${FILE_SIZE_UNITS[unitIndex]}`;
  }

  const rounded = Math.round(value * 100) / 100;
  return `${rounded} ${FILE_SIZE_UNITS[unitIndex]}`;
}
