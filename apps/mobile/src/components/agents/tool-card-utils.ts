export function getFilename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\u2026`;
}
