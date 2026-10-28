import { unzipSync, type UnzipFileInfo } from 'fflate';
import {
  MAX_IMPORT_ARCHIVE_ENTRIES,
  MAX_IMPORT_ARCHIVE_EXPANDED_BYTES,
  MAX_IMPORT_ENTRY_EXPANDED_BYTES,
  MAX_IMPORT_ZIP_BYTES,
} from './limits';
import type { ImportIssue } from './types';

/** One decoded archive entry: path relative to the config root, plus text content. */
export type ArchiveEntry = {
  path: string;
  content: string;
};

export type DecodedConfigArchive = {
  entries: ArchiveEntry[];
  issues: ImportIssue[];
};

export type ImportArchiveErrorCode =
  | 'invalid-archive'
  | 'archive-too-large'
  | 'archive-entry-count-exceeded'
  | 'archive-expansion-limit-exceeded'
  | 'duplicate-entry';

export class ImportArchiveError extends Error {
  readonly code: ImportArchiveErrorCode;

  constructor(code: ImportArchiveErrorCode, message: string) {
    super(message);
    this.name = 'ImportArchiveError';
    this.code = code;
  }
}

/** Directory names that mark a real config root; a sole top-level directory with one of these names is not a wrapper. */
const CONFIG_DIRECTORY_NAMES = new Set([
  'agent',
  'agents',
  'command',
  'commands',
  'skills',
  'instructions',
]);

/** Config file names that mark a real config root, so a bare config file is not treated as a wrapper. */
const CONFIG_FILE_NAMES = new Set(['kilo.json', 'kilo.jsonc']);

const JUNK_SEGMENT_NAMES = new Set(['__macosx', '.git', 'node_modules']);
const JUNK_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function archiveIssue(
  severity: ImportIssue['severity'],
  code: ImportIssue['code'],
  path: string | null,
  message: string
): ImportIssue {
  return { severity, code, category: 'archive', path, field: null, message };
}

type NormalizedEntryPath =
  | { kind: 'file'; path: string }
  | { kind: 'directory' }
  | { kind: 'invalid'; reason: string };

function normalizeEntryPath(rawName: string): NormalizedEntryPath {
  const slashed = rawName.replaceAll('\\', '/');
  if (slashed.endsWith('/')) return { kind: 'directory' };
  if (slashed.includes('\0')) return { kind: 'invalid', reason: 'contains a null byte' };

  let path = slashed;
  while (path.startsWith('./')) path = path.slice(2);
  if (path.startsWith('/')) return { kind: 'invalid', reason: 'is absolute' };

  const segments = path.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return { kind: 'invalid', reason: 'contains an empty or relative segment' };
  }

  return { kind: 'file', path };
}

function isJunkPath(path: string): boolean {
  const segments = path.split('/');
  const baseName = segments[segments.length - 1]?.toLowerCase() ?? '';
  if (baseName.startsWith('._')) return true;
  if (JUNK_FILE_NAMES.has(baseName)) return true;
  return segments.some(segment => JUNK_SEGMENT_NAMES.has(segment.toLowerCase()));
}

/**
 * Strip a single outer wrapper directory. A sole top-level directory is only
 * stripped when it is not a known config directory name, not a config file
 * name, and contains at least one nested entry — so an archive rooted at
 * `agent/` or `skills/` (an unwrapped single category) keeps its path.
 */
export function resolveConfigRoot(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const topLevelNames = new Set(paths.map(path => path.split('/')[0]));
  if (topLevelNames.size !== 1) return null;

  const [top] = topLevelNames;
  const lower = top.toLowerCase();
  if (CONFIG_DIRECTORY_NAMES.has(lower) || CONFIG_FILE_NAMES.has(lower)) return null;
  if (!paths.every(path => path.includes('/'))) return null;

  return top;
}

/**
 * Strip the sole outer wrapper of a skill bundle. Any single top-level
 * directory is stripped, matching the skill marketplace's
 * `tar --strip-components=1` contract, so a bundle zipped as `my-skill/SKILL.md`
 * or `commands/SKILL.md` is read from its root. An archive already rooted at
 * `SKILL.md` keeps its paths, and mixed roots are left alone.
 */
export function resolveSkillBundleRoot(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const topLevelNames = new Set(paths.map(path => path.split('/')[0]));
  if (topLevelNames.size !== 1) return null;
  if (!paths.every(path => path.includes('/'))) return null;
  return [...topLevelNames][0];
}

function decodeArchive(
  zipBytes: Uint8Array,
  resolveRoot: (paths: string[]) => string | null
): DecodedConfigArchive {
  if (zipBytes.byteLength > MAX_IMPORT_ZIP_BYTES) {
    throw new ImportArchiveError(
      'archive-too-large',
      `Archive exceeds ${MAX_IMPORT_ZIP_BYTES} bytes`
    );
  }

  const issues: ImportIssue[] = [];
  const seenPaths = new Set<string>();
  const inventory: Array<{ rawName: string; path: string }> = [];
  let entryCount = 0;
  let expandedTotal = 0;

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zipBytes, {
      filter: (file: UnzipFileInfo): boolean => {
        // Count every member before any filtering decision: directory, junk and
        // invalid members still count against the archive entry bound.
        entryCount += 1;
        if (entryCount > MAX_IMPORT_ARCHIVE_ENTRIES) {
          throw new ImportArchiveError(
            'archive-entry-count-exceeded',
            `Archive contains more than ${MAX_IMPORT_ARCHIVE_ENTRIES} entries`
          );
        }

        const normalized = normalizeEntryPath(file.name);
        if (normalized.kind === 'directory') return false;
        if (normalized.kind === 'invalid') {
          issues.push(
            archiveIssue(
              'warning',
              'invalid-entry-path',
              file.name,
              `Skipped ${file.name}: ${normalized.reason}`
            )
          );
          return false;
        }

        const path = normalized.path;
        if (isJunkPath(path)) return false;

        // Detect duplicates from the ordered entry inventory before fflate
        // reduces the archive to a keyed map (where later members win).
        if (seenPaths.has(path)) {
          throw new ImportArchiveError(
            'duplicate-entry',
            `Archive contains more than one entry for ${path}`
          );
        }
        seenPaths.add(path);

        // Stored members are copied using their compressed size, so a member
        // whose declared sizes differ would allocate more than originalSize.
        // Reject the malformed metadata before extraction instead of decoding.
        if (file.compression === 0 && file.size !== file.originalSize) {
          throw new ImportArchiveError(
            'invalid-archive',
            `${path} declares inconsistent stored sizes`
          );
        }
        // fflate 0.8.3 inflates into a fixed originalSize buffer; it does
        // not grow that buffer when a deflated member under-declares its size.
        const allocationBytes = file.compression === 0 ? file.size : file.originalSize;

        if (allocationBytes > MAX_IMPORT_ENTRY_EXPANDED_BYTES) {
          issues.push(
            archiveIssue(
              'error',
              'entry-too-large',
              path,
              `${path} expands to ${allocationBytes} bytes, over the per-entry expansion limit`
            )
          );
          return false;
        }

        expandedTotal += allocationBytes;
        if (expandedTotal > MAX_IMPORT_ARCHIVE_EXPANDED_BYTES) {
          throw new ImportArchiveError(
            'archive-expansion-limit-exceeded',
            `Archive expands beyond ${MAX_IMPORT_ARCHIVE_EXPANDED_BYTES} bytes`
          );
        }

        inventory.push({ rawName: file.name, path });
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ImportArchiveError) throw error;
    throw new ImportArchiveError('invalid-archive', 'Failed to read the ZIP archive');
  }

  const decoded: ArchiveEntry[] = [];
  for (const item of inventory) {
    const bytes = files[item.rawName];
    if (!bytes) {
      issues.push(
        archiveIssue('warning', 'unreadable-entry', item.path, `Could not read ${item.path}`)
      );
      continue;
    }
    try {
      decoded.push({ path: item.path, content: textDecoder.decode(bytes) });
    } catch {
      issues.push(
        archiveIssue(
          'warning',
          'unreadable-entry',
          item.path,
          `${item.path} is not valid UTF-8 text`
        )
      );
    }
  }

  const root = resolveRoot(decoded.map(entry => entry.path));
  if (!root) return { entries: decoded, issues };

  // Issue paths use the same root as entry paths, so callers can match them.
  const unwrap = (path: string) =>
    path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  return {
    entries: decoded.map(entry => ({ path: unwrap(entry.path), content: entry.content })),
    issues: issues.map(issue => (issue.path ? { ...issue, path: unwrap(issue.path) } : issue)),
  };
}

/** Decode a config directory archive, keeping an unwrapped single-category root. */
export function decodeConfigArchive(zipBytes: Uint8Array): DecodedConfigArchive {
  return decodeArchive(zipBytes, resolveConfigRoot);
}

/** Decode a skill bundle archive, stripping its sole outer wrapper directory. */
export function decodeSkillBundleArchive(zipBytes: Uint8Array): DecodedConfigArchive {
  return decodeArchive(zipBytes, resolveSkillBundleRoot);
}
