export function getFilename(filePath: string): string {
  const parts = filePath.split('/');
  return parts.at(-1) || filePath;
}

export function getDirectoryName(path: string): string {
  const cleaned = path.replace(/\/+$/, '');
  const parts = cleaned.split('/');
  return parts.at(-1) || path || '.';
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\u2026`;
}
