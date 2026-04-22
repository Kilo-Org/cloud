import { describe, expect, test } from '@jest/globals';
import { zipSync, strToU8 } from 'fflate';
import {
  detectOpenclawImportOs,
  getOpenclawZipCommandForOs,
  parseOpenclawWorkspaceZipBytes,
} from '@/app/(app)/claw/components/openclaw-import-zip';
import type { OpenclawWorkspaceZipError } from '@/app/(app)/claw/components/openclaw-import-zip';

function makeZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const payload: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) {
    payload[name] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(payload);
}

describe('parseOpenclawWorkspaceZipBytes', () => {
  test('parses valid root and recursive memory markdown files', () => {
    const zip = makeZip({
      'USER.md': '# User\n',
      'SOUL.md': '# Soul\n',
      'IDENTITY.md': '# Identity\n',
      'MEMORY.md': '# Memory\n',
      'memory/notes/day-1.md': '- note\n',
      'memory/deep/path/item.md': '- nested\n',
    });

    const result = parseOpenclawWorkspaceZipBytes(zip);

    expect(result.files).toEqual([
      { path: 'workspace/USER.md', content: '# User\n' },
      { path: 'workspace/SOUL.md', content: '# Soul\n' },
      { path: 'workspace/IDENTITY.md', content: '# Identity\n' },
      { path: 'workspace/MEMORY.md', content: '# Memory\n' },
      { path: 'workspace/memory/notes/day-1.md', content: '- note\n' },
      { path: 'workspace/memory/deep/path/item.md', content: '- nested\n' },
    ]);
    expect(result.previewPaths).toEqual([
      'IDENTITY.md',
      'MEMORY.md',
      'memory/deep/path/item.md',
      'memory/notes/day-1.md',
      'SOUL.md',
      'USER.md',
    ]);
  });

  test('ignores hidden/system archive paths', () => {
    const zip = makeZip({
      '__MACOSX/._USER.md': 'ignored',
      '.DS_Store': 'ignored',
      'USER.md': '# User\n',
      'memory/.cache/ignored.md': 'ignored',
      'memory/ok.md': '# ok\n',
      'thumbs.db': 'ignored',
    });

    const result = parseOpenclawWorkspaceZipBytes(zip);
    expect(result.previewPaths).toEqual(['memory/ok.md', 'USER.md']);
    expect(result.files).toEqual([
      { path: 'workspace/USER.md', content: '# User\n' },
      { path: 'workspace/memory/ok.md', content: '# ok\n' },
    ]);
  });

  test('rejects unsupported ZIP root shapes', () => {
    const zip = makeZip({
      'workspace/USER.md': '# User\n',
    });

    expect(() => parseOpenclawWorkspaceZipBytes(zip)).toThrow(
      expect.objectContaining({
        code: 'openclaw_import_invalid_path',
      } satisfies Partial<OpenclawWorkspaceZipError>)
    );
  });

  test('rejects non-markdown files in memory tree', () => {
    const zip = makeZip({
      'memory/note.txt': 'not markdown',
    });

    expect(() => parseOpenclawWorkspaceZipBytes(zip)).toThrow(
      expect.objectContaining({
        code: 'openclaw_import_invalid_path',
      } satisfies Partial<OpenclawWorkspaceZipError>)
    );
  });

  test('rejects case-insensitive path collisions', () => {
    const zip = makeZip({
      'memory/Foo.md': '# A',
      'memory/foo.md': '# B',
    });

    expect(() => parseOpenclawWorkspaceZipBytes(zip)).toThrow(
      expect.objectContaining({
        code: 'openclaw_import_path_case_conflict',
      } satisfies Partial<OpenclawWorkspaceZipError>)
    );
  });

  test('rejects files with control characters', () => {
    const zip = makeZip({
      'USER.md': 'hello\u0001world',
    });

    expect(() => parseOpenclawWorkspaceZipBytes(zip)).toThrow(
      expect.objectContaining({
        code: 'openclaw_import_invalid_markdown',
      } satisfies Partial<OpenclawWorkspaceZipError>)
    );
  });

  test('rejects empty/invalid file sets', () => {
    const zip = makeZip({
      '__MACOSX/._USER.md': 'ignored',
      '.DS_Store': 'ignored',
    });

    expect(() => parseOpenclawWorkspaceZipBytes(zip)).toThrow(
      expect.objectContaining({
        code: 'openclaw_import_no_files',
      } satisfies Partial<OpenclawWorkspaceZipError>)
    );
  });

  test('rejects ZIP with too many files', () => {
    const entries: Record<string, string> = {
      'USER.md': '# User\n',
    };

    for (let i = 0; i < 500; i++) {
      entries[`memory/note-${i}.md`] = `# ${i}\n`;
    }

    const zip = makeZip(entries);

    expect(() => parseOpenclawWorkspaceZipBytes(zip)).toThrow(
      expect.objectContaining({
        code: 'openclaw_import_too_many_files',
      } satisfies Partial<OpenclawWorkspaceZipError>)
    );
  });

  test('rejects file larger than extracted size cap', () => {
    const tooLarge = 'a'.repeat(5 * 1024 * 1024 + 1);
    const zip = makeZip({
      'USER.md': tooLarge,
    });

    expect(() => parseOpenclawWorkspaceZipBytes(zip)).toThrow(
      expect.objectContaining({
        code: 'openclaw_import_too_large',
      } satisfies Partial<OpenclawWorkspaceZipError>)
    );
  });
});

describe('detectOpenclawImportOs', () => {
  test('detects windows', () => {
    expect(detectOpenclawImportOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
  });

  test('detects macos', () => {
    expect(detectOpenclawImportOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos');
  });

  test('defaults to linux', () => {
    expect(detectOpenclawImportOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(detectOpenclawImportOs('unknown-agent')).toBe('linux');
  });
});

describe('getOpenclawZipCommandForOs', () => {
  test('returns commands for each OS', () => {
    expect(getOpenclawZipCommandForOs('windows').command).toContain('Compress-Archive');

    const unixCommandSuffix =
      'o="$HOME/Desktop/openclaw-workspace.zip";rm -f "$o";zip -r "$o" "$@"';
    expect(getOpenclawZipCommandForOs('macos').command).toContain(unixCommandSuffix);
    expect(getOpenclawZipCommandForOs('linux').command).toContain(unixCommandSuffix);
  });
});
