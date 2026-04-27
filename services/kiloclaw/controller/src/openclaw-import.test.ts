import { describe, expect, it } from 'vitest';
import {
  isOpenclawImportPathAllowed,
  isOpenclawMarkdownContent,
  mapOpenclawZipPathToImportPath,
  normalizeOpenclawImportPath,
  OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES,
  OPENCLAW_IMPORT_MAX_FILE_UTF8_BYTES,
  OPENCLAW_IMPORT_MAX_FILES,
  OPENCLAW_IMPORT_MAX_ZIP_BYTES,
  OPENCLAW_IMPORT_MEMORY_PREFIX,
  OPENCLAW_IMPORT_ZIP_MEMORY_PREFIX,
} from './openclaw-import';

describe('openclaw import constants', () => {
  it('exposes expected limits', () => {
    expect(OPENCLAW_IMPORT_MAX_FILES).toBe(500);
    expect(OPENCLAW_IMPORT_MAX_ZIP_BYTES).toBe(5 * 1024 * 1024);
    expect(OPENCLAW_IMPORT_MAX_EXTRACTED_UTF8_BYTES).toBe(5 * 1024 * 1024);
    expect(OPENCLAW_IMPORT_MAX_FILE_UTF8_BYTES).toBe(5 * 1024 * 1024);
  });

  it('exposes expected path prefixes', () => {
    expect(OPENCLAW_IMPORT_MEMORY_PREFIX).toBe('workspace/memory/');
    expect(OPENCLAW_IMPORT_ZIP_MEMORY_PREFIX).toBe('memory/');
  });
});

describe('normalizeOpenclawImportPath', () => {
  it('normalizes slash styles', () => {
    expect(normalizeOpenclawImportPath('memory\\a.md')).toBe('memory/a.md');
    expect(normalizeOpenclawImportPath('./memory/a.md')).toBe('memory/a.md');
  });

  it('rejects invalid segments', () => {
    expect(() => normalizeOpenclawImportPath('memory//a.md')).toThrow();
    expect(() => normalizeOpenclawImportPath('memory/../a.md')).toThrow();
    expect(() => normalizeOpenclawImportPath('memory/./a.md')).toThrow();
  });

  it('rejects drive prefixes', () => {
    expect(() => normalizeOpenclawImportPath('C:/memory/a.md')).toThrow();
  });
});

describe('isOpenclawImportPathAllowed', () => {
  it('accepts root workspace files', () => {
    expect(isOpenclawImportPathAllowed('workspace/USER.md')).toBe(true);
    expect(isOpenclawImportPathAllowed('workspace/SOUL.md')).toBe(true);
    expect(isOpenclawImportPathAllowed('workspace/IDENTITY.md')).toBe(true);
    expect(isOpenclawImportPathAllowed('workspace/MEMORY.md')).toBe(true);
  });

  it('accepts recursive memory markdown files', () => {
    expect(isOpenclawImportPathAllowed('workspace/memory/a.md')).toBe(true);
    expect(isOpenclawImportPathAllowed('workspace/memory/deep/note.md')).toBe(true);
  });

  it('rejects non-allowlisted paths', () => {
    expect(isOpenclawImportPathAllowed('workspace/AGENTS.md')).toBe(false);
    expect(isOpenclawImportPathAllowed('workspace/memory/a.txt')).toBe(false);
    expect(isOpenclawImportPathAllowed('workspace/memory/')).toBe(false);
  });
});

describe('mapOpenclawZipPathToImportPath', () => {
  it('maps root names to workspace paths', () => {
    expect(mapOpenclawZipPathToImportPath('USER.md')).toBe('workspace/USER.md');
    expect(mapOpenclawZipPathToImportPath('SOUL.md')).toBe('workspace/SOUL.md');
    expect(mapOpenclawZipPathToImportPath('IDENTITY.md')).toBe('workspace/IDENTITY.md');
    expect(mapOpenclawZipPathToImportPath('MEMORY.md')).toBe('workspace/MEMORY.md');
  });

  it('maps recursive memory markdown paths', () => {
    expect(mapOpenclawZipPathToImportPath('memory/a.md')).toBe('workspace/memory/a.md');
    expect(mapOpenclawZipPathToImportPath('memory/deep/path/b.md')).toBe(
      'workspace/memory/deep/path/b.md'
    );
  });

  it('rejects unsupported archive paths', () => {
    expect(mapOpenclawZipPathToImportPath('workspace/USER.md')).toBeNull();
    expect(mapOpenclawZipPathToImportPath('memory/a.txt')).toBeNull();
    expect(mapOpenclawZipPathToImportPath('random.md')).toBeNull();
  });

  it('rejects paths with invalid segments', () => {
    expect(mapOpenclawZipPathToImportPath('memory/../SOUL.md')).toBeNull();
    expect(mapOpenclawZipPathToImportPath('memory/./note.md')).toBeNull();
    expect(mapOpenclawZipPathToImportPath('memory//note.md')).toBeNull();
  });
});

describe('isOpenclawMarkdownContent', () => {
  it('accepts plain markdown', () => {
    expect(isOpenclawMarkdownContent('# title\nbody\n')).toBe(true);
    expect(isOpenclawMarkdownContent('line\twith\ttab\n')).toBe(true);
  });

  it('rejects control characters', () => {
    expect(isOpenclawMarkdownContent('ok\u0001bad')).toBe(false);
    expect(isOpenclawMarkdownContent('ok\u007Fbad')).toBe(false);
  });
});
