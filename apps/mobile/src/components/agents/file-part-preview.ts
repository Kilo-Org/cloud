import { isMarkdownPath } from './read-tool-markdown';

export type FilePartKind = 'image' | 'markdown' | 'other';

export function isMarkdownFilePart(filename: string | undefined): boolean {
  return isMarkdownPath(filename ?? '');
}

export function getFilePartKind(input: { mime: string; filename?: string }): FilePartKind {
  if (input.mime.startsWith('image/')) {
    return 'image';
  }
  if (isMarkdownFilePart(input.filename)) {
    return 'markdown';
  }
  return 'other';
}

function resolveName(filename: string | undefined): string {
  return filename && filename.trim() !== '' ? filename : 'File';
}

export function getFilePartAccessibilityLabel(kind: FilePartKind, filename?: string): string {
  const name = resolveName(filename);
  if (kind === 'image') {
    return `Open ${name} full screen`;
  }
  if (kind === 'markdown') {
    return `Preview ${name}`;
  }
  return `Open ${name}`;
}
