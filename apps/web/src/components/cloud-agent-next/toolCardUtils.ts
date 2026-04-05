export function getFilename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

export function getDirectoryName(path: string): string {
  const cleaned = path.replace(/\/+$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || path || '.';
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}
