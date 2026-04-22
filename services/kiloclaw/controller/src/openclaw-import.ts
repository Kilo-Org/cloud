export const OPENCLAW_IMPORT_MAX_ZIP_BYTES = 5 * 1024 * 1024;
export const OPENCLAW_IMPORT_MAX_FILES = 500;
export const OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES = 5 * 1024 * 1024;
export const OPENCLAW_IMPORT_MAX_FILE_UTF8_BYTES = OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES;

export const OPENCLAW_IMPORT_ROOT_FILE_NAMES = [
  'USER.md',
  'SOUL.md',
  'IDENTITY.md',
  'MEMORY.md',
] as const;

export const OPENCLAW_IMPORT_MEMORY_PREFIX = 'workspace/memory/';
export const OPENCLAW_IMPORT_ZIP_MEMORY_PREFIX = 'memory/';

const OPENCLAW_IMPORT_ROOT_PATHS = OPENCLAW_IMPORT_ROOT_FILE_NAMES.map(name => `workspace/${name}`);
const OPENCLAW_IMPORT_ROOT_PATH_SET = new Set<string>(OPENCLAW_IMPORT_ROOT_PATHS);
const OPENCLAW_IMPORT_ROOT_NAME_TO_PATH = new Map<string, string>(
  OPENCLAW_IMPORT_ROOT_FILE_NAMES.map(name => [name, `workspace/${name}`])
);

export function normalizeOpenclawImportPath(rawPath: string): string {
  const withForwardSlashes = rawPath.replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = withForwardSlashes.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('OpenClaw import path contains invalid segments');
  }

  if (/^[A-Za-z]:$/.test(segments[0] ?? '')) {
    throw new Error('OpenClaw import path must not include drive letters');
  }

  return segments.join('/');
}

export function isOpenclawImportPathAllowed(importPath: string): boolean {
  if (OPENCLAW_IMPORT_ROOT_PATH_SET.has(importPath)) {
    return true;
  }

  if (!importPath.startsWith(OPENCLAW_IMPORT_MEMORY_PREFIX)) {
    return false;
  }

  const memoryRelativePath = importPath.slice(OPENCLAW_IMPORT_MEMORY_PREFIX.length);
  if (!memoryRelativePath || memoryRelativePath.endsWith('/')) {
    return false;
  }

  return memoryRelativePath.toLowerCase().endsWith('.md');
}

export function mapOpenclawZipPathToImportPath(archivePath: string): string | null {
  let normalizedArchivePath: string;
  try {
    normalizedArchivePath = normalizeOpenclawImportPath(archivePath);
  } catch {
    return null;
  }

  const rootTarget = OPENCLAW_IMPORT_ROOT_NAME_TO_PATH.get(normalizedArchivePath);
  if (rootTarget) {
    return rootTarget;
  }

  if (!normalizedArchivePath.startsWith(OPENCLAW_IMPORT_ZIP_MEMORY_PREFIX)) {
    return null;
  }

  const memoryRelativePath = normalizedArchivePath.slice(OPENCLAW_IMPORT_ZIP_MEMORY_PREFIX.length);
  if (!memoryRelativePath || memoryRelativePath.endsWith('/')) {
    return null;
  }

  if (!memoryRelativePath.toLowerCase().endsWith('.md')) {
    return null;
  }

  return `${OPENCLAW_IMPORT_MEMORY_PREFIX}${memoryRelativePath}`;
}

export function isOpenclawMarkdownContent(content: string): boolean {
  for (const char of content) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) {
      return false;
    }
  }

  return true;
}
