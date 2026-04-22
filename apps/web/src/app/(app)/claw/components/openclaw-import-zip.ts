import { unzipSync } from 'fflate';
import {
  OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES,
  OPENCLAW_IMPORT_MAX_FILES,
  OPENCLAW_IMPORT_MAX_FILE_UTF8_BYTES,
  OPENCLAW_IMPORT_MAX_ZIP_BYTES,
  mapOpenclawZipPathToImportPath,
  normalizeOpenclawImportPath,
  isOpenclawMarkdownContent,
} from '../../../../../../../services/kiloclaw/controller/src/openclaw-import';

export {
  OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES,
  OPENCLAW_IMPORT_MAX_FILES,
  OPENCLAW_IMPORT_MAX_FILE_UTF8_BYTES,
  OPENCLAW_IMPORT_MAX_ZIP_BYTES,
};

export type OpenclawImportOs = 'windows' | 'macos' | 'linux';

export type OpenclawWorkspaceImportFile = {
  path: string;
  content: string;
};

export type ParsedOpenclawWorkspaceZip = {
  files: OpenclawWorkspaceImportFile[];
  previewPaths: string[];
  totalUtf8Bytes: number;
};

export type OpenclawZipCommand = {
  command: string;
};

export class OpenclawWorkspaceZipError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OpenclawWorkspaceZipError';
    this.code = code;
  }
}

const OPENCLAW_ZIP_COMMANDS: Record<OpenclawImportOs, OpenclawZipCommand> = {
  windows: {
    command:
      '$w="$HOME\\.openclaw\\workspace";if(-not (Test-Path -LiteralPath $w -PathType Container)){Write-Error "Error: OpenClaw workspace folder not found at $w (expected ~/.openclaw/workspace).";exit 1};$p=@("$w\\USER.md","$w\\SOUL.md","$w\\IDENTITY.md","$w\\MEMORY.md","$w\\memory")|?{Test-Path -LiteralPath $_};Compress-Archive -Path $p -DestinationPath "$HOME\\Desktop\\openclaw-workspace.zip" -Force',
  },
  macos: {
    command:
      'w="$HOME/.openclaw/workspace";[ -d "$w" ] || { echo "Error: OpenClaw workspace folder not found at $w (expected ~/.openclaw/workspace)." >&2; exit 1; };cd "$w" || exit 1;set --;for f in USER.md SOUL.md IDENTITY.md MEMORY.md memory; do [ -e "$f" ] && set -- "$@" "$f"; done;[ "$#" -gt 0 ] || { echo "Error: No OpenClaw workspace files found at $w." >&2; exit 1; };o="$HOME/Desktop/openclaw-workspace.zip";rm -f "$o";zip -r "$o" "$@"',
  },
  linux: {
    command:
      'w="$HOME/.openclaw/workspace";[ -d "$w" ] || { echo "Error: OpenClaw workspace folder not found at $w (expected ~/.openclaw/workspace)." >&2; exit 1; };cd "$w" || exit 1;set --;for f in USER.md SOUL.md IDENTITY.md MEMORY.md memory; do [ -e "$f" ] && set -- "$@" "$f"; done;[ "$#" -gt 0 ] || { echo "Error: No OpenClaw workspace files found at $w." >&2; exit 1; };o="$HOME/Desktop/openclaw-workspace.zip";rm -f "$o";zip -r "$o" "$@"',
  },
};

const textDecoder = new TextDecoder('utf-8', { fatal: true });

function normalizeArchivePath(path: string): string {
  try {
    return normalizeOpenclawImportPath(path);
  } catch {
    throw new OpenclawWorkspaceZipError(
      'openclaw_import_invalid_path',
      `Unsupported zip file path: ${path}`
    );
  }
}

function isSystemArchivePath(path: string): boolean {
  const parts = path.split('/');
  const baseName = parts[parts.length - 1]?.toLowerCase() ?? '';

  if (parts.some(part => part === '__MACOSX')) return true;
  if (parts.some(part => part.startsWith('.'))) return true;
  if (baseName === 'thumbs.db' || baseName === 'desktop.ini') return true;

  return false;
}

function normalizeZipEntries(zipEntries: Record<string, Uint8Array>): Array<[string, Uint8Array]> {
  const normalized: Array<[string, Uint8Array]> = [];
  for (const [rawPath, bytes] of Object.entries(zipEntries)) {
    if (rawPath.endsWith('/')) continue;

    const archivePath = normalizeArchivePath(rawPath);
    if (isSystemArchivePath(archivePath)) continue;

    normalized.push([archivePath, bytes]);
  }

  return normalized;
}

function mapArchivePathToImportPath(archivePath: string): string {
  const mapped = mapOpenclawZipPathToImportPath(archivePath);
  if (!mapped) {
    throw new OpenclawWorkspaceZipError(
      'openclaw_import_invalid_path',
      `Unsupported zip file path: ${archivePath}`
    );
  }

  return mapped;
}

function decodeMarkdown(path: string, bytes: Uint8Array): string {
  let decoded: string;
  try {
    decoded = textDecoder.decode(bytes);
  } catch {
    throw new OpenclawWorkspaceZipError(
      'openclaw_import_invalid_markdown',
      `File is not valid UTF-8 Markdown: ${path}`
    );
  }

  if (!isOpenclawMarkdownContent(decoded)) {
    throw new OpenclawWorkspaceZipError(
      'openclaw_import_invalid_markdown',
      `File contains non-text content: ${path}`
    );
  }

  return decoded;
}

function parseZipBytes(buffer: Uint8Array): ParsedOpenclawWorkspaceZip {
  let zipEntries: Record<string, Uint8Array>;
  let expectedFileCount = 0;
  let expectedUtf8Bytes = 0;

  try {
    zipEntries = unzipSync(buffer, {
      filter(file) {
        const normalizedRawName = file.name.replaceAll('\\', '/').replace(/^\.\//, '');
        if (normalizedRawName.endsWith('/')) {
          return false;
        }

        const archivePath = normalizeArchivePath(file.name);
        if (isSystemArchivePath(archivePath)) {
          return false;
        }

        expectedFileCount += 1;
        if (expectedFileCount > OPENCLAW_IMPORT_MAX_FILES) {
          throw new OpenclawWorkspaceZipError(
            'openclaw_import_too_many_files',
            `zip file contains more than ${OPENCLAW_IMPORT_MAX_FILES} files`
          );
        }

        mapArchivePathToImportPath(archivePath);

        if (file.originalSize > OPENCLAW_IMPORT_MAX_FILE_UTF8_BYTES) {
          throw new OpenclawWorkspaceZipError(
            'openclaw_import_too_large',
            `File exceeds ${OPENCLAW_IMPORT_MAX_FILE_UTF8_BYTES} bytes: ${archivePath}`
          );
        }

        expectedUtf8Bytes += file.originalSize;
        if (expectedUtf8Bytes > OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES) {
          throw new OpenclawWorkspaceZipError(
            'openclaw_import_too_large',
            `Extracted Markdown exceeds ${OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES} bytes`
          );
        }

        return true;
      },
    });
  } catch (error) {
    if (error instanceof OpenclawWorkspaceZipError) {
      throw error;
    }
    throw new OpenclawWorkspaceZipError('openclaw_import_invalid_zip', 'Failed to read zip file');
  }

  const entries = normalizeZipEntries(zipEntries);
  const files: OpenclawWorkspaceImportFile[] = [];
  const previewPaths: string[] = [];
  const seenCaseInsensitivePaths = new Map<string, string>();
  let totalUtf8Bytes = 0;

  for (const [archivePath, bytes] of entries) {
    const importPath = mapArchivePathToImportPath(archivePath);

    const caseInsensitivePath = importPath.toLowerCase();
    const existing = seenCaseInsensitivePaths.get(caseInsensitivePath);
    if (existing) {
      throw new OpenclawWorkspaceZipError(
        'openclaw_import_path_case_conflict',
        `zip file contains conflicting paths: ${existing} and ${importPath}`
      );
    }

    const content = decodeMarkdown(archivePath, bytes);
    if (bytes.byteLength > OPENCLAW_IMPORT_MAX_FILE_UTF8_BYTES) {
      throw new OpenclawWorkspaceZipError(
        'openclaw_import_too_large',
        `File exceeds ${OPENCLAW_IMPORT_MAX_FILE_UTF8_BYTES} bytes: ${archivePath}`
      );
    }

    totalUtf8Bytes += bytes.byteLength;
    if (totalUtf8Bytes > OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES) {
      throw new OpenclawWorkspaceZipError(
        'openclaw_import_too_large',
        `Extracted Markdown exceeds ${OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES} bytes`
      );
    }

    seenCaseInsensitivePaths.set(caseInsensitivePath, importPath);
    files.push({ path: importPath, content });
    previewPaths.push(archivePath);
  }

  if (files.length === 0) {
    throw new OpenclawWorkspaceZipError(
      'openclaw_import_no_files',
      'zip file contains no valid OpenClaw workspace files'
    );
  }

  if (files.length > OPENCLAW_IMPORT_MAX_FILES) {
    throw new OpenclawWorkspaceZipError(
      'openclaw_import_too_many_files',
      `zip file contains more than ${OPENCLAW_IMPORT_MAX_FILES} files`
    );
  }

  const sortedPreviewPaths = [...previewPaths].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );

  return {
    files,
    previewPaths: sortedPreviewPaths,
    totalUtf8Bytes,
  };
}

export async function parseOpenclawWorkspaceZipFile(
  file: File
): Promise<ParsedOpenclawWorkspaceZip> {
  if (file.size > OPENCLAW_IMPORT_MAX_ZIP_BYTES) {
    throw new OpenclawWorkspaceZipError(
      'openclaw_import_zip_too_large',
      `zip file exceeds ${OPENCLAW_IMPORT_MAX_ZIP_BYTES} bytes`
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  return parseZipBytes(bytes);
}

export function parseOpenclawWorkspaceZipBytes(bytes: Uint8Array): ParsedOpenclawWorkspaceZip {
  if (bytes.byteLength > OPENCLAW_IMPORT_MAX_ZIP_BYTES) {
    throw new OpenclawWorkspaceZipError(
      'openclaw_import_zip_too_large',
      `zip file exceeds ${OPENCLAW_IMPORT_MAX_ZIP_BYTES} bytes`
    );
  }
  return parseZipBytes(bytes);
}

export function detectOpenclawImportOs(userAgent: string): OpenclawImportOs {
  const ua = userAgent.toLowerCase();
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('macintosh') || ua.includes('mac os')) return 'macos';
  return 'linux';
}

export function getOpenclawZipCommandForOs(os: OpenclawImportOs): OpenclawZipCommand {
  return OPENCLAW_ZIP_COMMANDS[os];
}
