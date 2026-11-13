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
    if (segment === '') {
      continue;
    }
    current = `${current}/${segment}`;
    trail.push({ label: segment, path: current });
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

const IMAGE_EXTENSIONS: Readonly<Record<string, true>> = {
  png: true,
  jpg: true,
  jpeg: true,
  gif: true,
  webp: true,
  bmp: true,
  heic: true,
  heif: true,
  avif: true,
};

/** Extensions the text preview opens as UTF-8. */
const TEXT_EXTENSIONS: Readonly<Record<string, true>> = {
  txt: true,
  md: true,
  markdown: true,
  json: true,
  jsonl: true,
  yml: true,
  yaml: true,
  toml: true,
  ini: true,
  conf: true,
  cfg: true,
  env: true,
  log: true,
  csv: true,
  tsv: true,
  xml: true,
  html: true,
  htm: true,
  css: true,
  scss: true,
  js: true,
  mjs: true,
  cjs: true,
  jsx: true,
  ts: true,
  tsx: true,
  sh: true,
  bash: true,
  zsh: true,
  fish: true,
  py: true,
  rb: true,
  go: true,
  rs: true,
  c: true,
  h: true,
  cc: true,
  cpp: true,
  hpp: true,
  java: true,
  kt: true,
  swift: true,
  php: true,
  sql: true,
  service: true,
  dockerfile: true,
  makefile: true,
};

export type PreviewKind = 'text' | 'image';

/** How the app can show this entry in place, or null when it has to be shared. */
export function previewKindOf(entry: Pick<SftpEntry, 'name' | 'kind' | 'size'>): PreviewKind | null {
  if (entry.kind !== 'file') {
    return null;
  }
  const extension = extensionOf(entry.name);
  if (IMAGE_EXTENSIONS[extension] === true) {
    return 'image';
  }
  if (TEXT_EXTENSIONS[extension] === true && entry.size <= MAX_PREVIEW_BYTES) {
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
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}
