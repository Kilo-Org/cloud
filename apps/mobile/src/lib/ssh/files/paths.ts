import { type SftpEntry } from '@kilocode/react-native-ssh';

/** The largest file the text preview opens; larger files are shared, not read. */
export const MAX_PREVIEW_BYTES = 1024 * 1024;

export function joinRemotePath(directory: string, name: string): string {
  if (directory === '/' || directory === '') {
    return `/${name}`;
  }
  return `${directory.replace(/\/+$/, '')}/${name}`;
}

/** The directory above `path`; the filesystem root is its own parent. */
export function parentRemotePath(path: string): string {
  if (path === '/') {
    return '/';
  }
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

export type Breadcrumb = Readonly<{ label: string; path: string }>;

/** The path from the root, one crumb per segment, ending at `path` itself. */
export function breadcrumbTrail(path: string): Breadcrumb[] {
  if (path === '/' || path === '') {
    return [{ label: '/', path: '/' }];
  }
  const trail: Breadcrumb[] = [{ label: '/', path: '/' }];
  let current = '';
  for (const segment of path.split('/')) {
    if (segment !== '') {
      current = `${current}/${segment}`;
      trail.push({ label: segment, path: current });
    }
  }
  return trail;
}

/** Directories first, then names in the device's collation, case-insensitively. */
export function sortEntries(entries: readonly SftpEntry[], collator: Intl.Collator): SftpEntry[] {
  return [...entries].sort((left, right) => {
    const leftDirectory = left.kind === 'directory';
    if (leftDirectory !== (right.kind === 'directory')) {
      return leftDirectory ? -1 : 1;
    }
    return collator.compare(left.name, right.name);
  });
}

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'heic',
  'heif',
  'avif',
]);

/** Extensions the text preview opens as UTF-8. */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonl',
  'yml',
  'yaml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'env',
  'log',
  'csv',
  'tsv',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'sh',
  'bash',
  'zsh',
  'fish',
  'py',
  'rb',
  'go',
  'rs',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'java',
  'kt',
  'swift',
  'php',
  'sql',
  'service',
  'dockerfile',
  'makefile',
]);

/**
 * The directory an SFTP channel opens in.
 *
 * `.` is the channel's working directory, which the server sets to the login
 * directory. `~` is not expanded by OpenSSH's sftp-server: the client joins it
 * onto the working directory, so the screen asks for a `/home/user/~` that does
 * not exist and every listing fails as not found.
 */
export function resolveHomeDirectory(
  channel: string,
  resolvePath: (channel: string, path: string) => Promise<string>
): Promise<string> {
  return resolvePath(channel, '.');
}

export type PreviewKind = 'text' | 'image';

/** How the app can show this entry in place, or null when it has to be shared. */
export function previewKindOf(
  entry: Pick<SftpEntry, 'name' | 'kind' | 'size'>
): PreviewKind | null {
  if (entry.kind !== 'file') {
    return null;
  }
  const extension = extensionOf(entry.name);
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  if (TEXT_EXTENSIONS.has(extension) && entry.size <= MAX_PREVIEW_BYTES) {
    return 'text';
  }
  return null;
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) {
    return lower;
  }
  return lower.slice(dot + 1);
}

/** Splits a remote path into the file's name, which is what a row shows. */
export function fileNameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}
