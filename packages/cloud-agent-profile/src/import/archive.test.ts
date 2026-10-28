import { describe, expect, test } from 'vitest';
import {
  decodeConfigArchive,
  decodeSkillBundleArchive,
  ImportArchiveError,
  resolveConfigRoot,
  resolveSkillBundleRoot,
  type ImportArchiveErrorCode,
} from './index';
import {
  MAX_IMPORT_ARCHIVE_ENTRIES,
  MAX_IMPORT_ARCHIVE_EXPANDED_BYTES,
  MAX_IMPORT_ENCODED_LENGTH,
  MAX_IMPORT_ENTRY_EXPANDED_BYTES,
  MAX_IMPORT_ZIP_BYTES,
  isImportArchiveWithinLimit,
  isImportEncodedWithinLimit,
} from './limits';
import { buildStoredZip, buildZip } from './test-fixtures';

function expectArchiveError(run: () => unknown, code: ImportArchiveErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ImportArchiveError);
    expect((error as ImportArchiveError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ImportArchiveError with code ${code}`);
}

describe('resolveConfigRoot', () => {
  test('strips an unrecognized outer wrapper directory', () => {
    expect(resolveConfigRoot(['my-config/agent/reviewer.md'])).toBe('my-config');
    expect(resolveConfigRoot(['.kilo/command/fix.md', '.kilo/skills/deploy/SKILL.md'])).toBe(
      '.kilo'
    );
  });

  test('keeps a sole top-level directory that is a known config directory name', () => {
    expect(resolveConfigRoot(['agent/reviewer.md'])).toBeNull();
    expect(resolveConfigRoot(['agents/reviewer.md', 'commands/fix.md'])).toBeNull();
    expect(resolveConfigRoot(['skills/deploy/SKILL.md'])).toBeNull();
    expect(resolveConfigRoot(['instructions/style.md'])).toBeNull();
  });

  test('keeps a bare config file and mixed roots', () => {
    expect(resolveConfigRoot(['kilo.jsonc'])).toBeNull();
    expect(resolveConfigRoot(['kilo.json', 'agent/reviewer.md'])).toBeNull();
  });
});

describe('resolveSkillBundleRoot', () => {
  test('strips a sole top-level directory even when it is a config directory name', () => {
    expect(resolveSkillBundleRoot(['commands/SKILL.md'])).toBe('commands');
    expect(resolveSkillBundleRoot(['skills/deploy/SKILL.md'])).toBe('skills');
    expect(resolveSkillBundleRoot(['my-skill/SKILL.md'])).toBe('my-skill');
  });

  test('keeps a bundle already rooted at SKILL.md', () => {
    expect(resolveSkillBundleRoot(['SKILL.md'])).toBeNull();
    expect(resolveSkillBundleRoot(['SKILL.md', 'helper.txt'])).toBeNull();
  });

  test('keeps mixed roots with a stray root file', () => {
    expect(resolveSkillBundleRoot(['my-skill/SKILL.md', 'README.md'])).toBeNull();
  });
});

describe('decodeConfigArchive', () => {
  test('decodes entries and strips a wrapper directory', () => {
    const decoded = decodeConfigArchive(
      buildZip({ 'my-config/agent/reviewer.md': 'Review.', 'my-config/kilo.jsonc': '{}' })
    );
    expect(decoded.entries.map(entry => entry.path).sort()).toEqual([
      'agent/reviewer.md',
      'kilo.jsonc',
    ]);
    expect(decoded.issues).toEqual([]);
  });

  test('does not strip a wrapper that also names a top-level file', () => {
    const zip = buildZip({ foo: 'Root file', 'foo/bar.md': 'Nested file' });
    for (const decode of [decodeConfigArchive, decodeSkillBundleArchive]) {
      expect(
        decode(zip)
          .entries.map(entry => entry.path)
          .sort()
      ).toEqual(['foo', 'foo/bar.md']);
    }
  });

  test('bounds a deflated member with an under-declared expanded size', () => {
    const zip = buildZip({
      'instructions/big.md': 'x'.repeat(MAX_IMPORT_ENTRY_EXPANDED_BYTES + 1),
    });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const centralOffset = view.getUint32(zip.byteLength - 6, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    expect(view.getUint16(centralOffset + 10, true)).toBe(8);
    view.setUint32(centralOffset + 24, 1, true);

    // unzipSync supplies a fixed output buffer to inflateSync. A forged size
    // truncates output rather than allocating the stream's expanded size.
    const decoded = decodeConfigArchive(zip);
    expect(decoded.entries).toEqual([{ path: 'instructions/big.md', content: 'x' }]);
  });

  test('keeps an unwrapped single-category archive at its root', () => {
    const decoded = decodeConfigArchive(buildZip({ 'agent/reviewer.md': 'Review.' }));
    expect(decoded.entries.map(entry => entry.path)).toEqual(['agent/reviewer.md']);
  });

  test('skips junk entries and directory members', () => {
    const decoded = decodeConfigArchive(
      buildZip({
        'agent/reviewer.md': 'Review.',
        '__MACOSX/agent/._reviewer.md': 'junk',
        '.DS_Store': 'junk',
        'agent/': '',
      })
    );
    expect(decoded.entries.map(entry => entry.path)).toEqual(['agent/reviewer.md']);
  });

  test('skips AppleDouble companion entries at any depth', () => {
    const decoded = decodeConfigArchive(
      buildZip({
        'agent/reviewer.md': 'Review.',
        'agent/._reviewer.md': 'junk',
        '._SKILL.md': 'junk',
      })
    );
    expect(decoded.entries.map(entry => entry.path)).toEqual(['agent/reviewer.md']);
  });

  test('decodes a skill bundle rooted under a reserved config directory name', () => {
    const decoded = decodeSkillBundleArchive(
      buildZip({ 'commands/SKILL.md': '# Skill', 'commands/helper.txt': 'Helper.' })
    );
    expect(decoded.entries.map(entry => entry.path).sort()).toEqual(['SKILL.md', 'helper.txt']);
  });

  test('keeps a skill bundle already rooted at SKILL.md', () => {
    const decoded = decodeSkillBundleArchive(buildZip({ 'SKILL.md': '# Skill' }));
    expect(decoded.entries.map(entry => entry.path)).toEqual(['SKILL.md']);
  });

  test('reports invalid entry paths as warnings instead of dropping them silently', () => {
    const decoded = decodeConfigArchive(
      buildZip({ 'agent/reviewer.md': 'Review.', '/etc/passwd': 'nope' })
    );
    expect(decoded.entries.map(entry => entry.path)).toEqual(['agent/reviewer.md']);
    const issue = decoded.issues.find(candidate => candidate.code === 'invalid-entry-path');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
    expect(issue?.path).toBe('/etc/passwd');
  });

  test('reports non-UTF-8 entries as unreadable instead of dropping them silently', () => {
    const decoded = decodeConfigArchive(
      buildZip({
        'agent/reviewer.md': 'Review.',
        'agent/binary.bin': new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
      })
    );
    expect(decoded.entries.map(entry => entry.path)).toEqual(['agent/reviewer.md']);
    const issue = decoded.issues.find(candidate => candidate.code === 'unreadable-entry');
    expect(issue?.severity).toBe('warning');
    expect(issue?.path).toBe('agent/binary.bin');
  });

  test('rejects an archive over the derived compressed cap', () => {
    expectArchiveError(
      () => decodeConfigArchive(new Uint8Array(MAX_IMPORT_ZIP_BYTES + 1)),
      'archive-too-large'
    );
  });

  test('accepts an archive at the compressed cap and fails as an invalid archive instead', () => {
    expect(isImportArchiveWithinLimit({ byteLength: MAX_IMPORT_ZIP_BYTES })).toBe(true);
    expect(isImportArchiveWithinLimit({ byteLength: MAX_IMPORT_ZIP_BYTES + 1 })).toBe(false);
    expectArchiveError(
      () => decodeConfigArchive(new Uint8Array(MAX_IMPORT_ZIP_BYTES)),
      'invalid-archive'
    );
  });

  test('enforces the encoded request-body budget before decoding', () => {
    expect(isImportEncodedWithinLimit('a'.repeat(MAX_IMPORT_ENCODED_LENGTH))).toBe(true);
    expect(isImportEncodedWithinLimit('a'.repeat(MAX_IMPORT_ENCODED_LENGTH + 1))).toBe(false);
  });

  test('rejects repeated ZIP member paths before building a keyed map', () => {
    const zip = buildStoredZip([
      { path: 'agent/reviewer.md', content: 'First.' },
      { path: 'agent/reviewer.md', content: 'Second.' },
    ]);
    expectArchiveError(() => decodeConfigArchive(zip), 'duplicate-entry');
  });

  test('reports an over-limit entry as an issue naming the entry', () => {
    const oversized = new Uint8Array(MAX_IMPORT_ENTRY_EXPANDED_BYTES + 1);
    const decoded = decodeConfigArchive(
      buildZip({ 'agent/reviewer.md': 'Review.', 'agent/huge.md': oversized })
    );
    expect(decoded.entries.map(entry => entry.path)).toEqual(['agent/reviewer.md']);
    const issue = decoded.issues.find(candidate => candidate.code === 'entry-too-large');
    expect(issue?.severity).toBe('error');
    expect(issue?.path).toBe('agent/huge.md');
    expect(issue?.message).toContain('agent/huge.md');
  });

  test('aborts when the entry count exceeds its limit', () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_IMPORT_ARCHIVE_ENTRIES + 1; index += 1) {
      files[`agent/agent-${index}.md`] = 'Review.';
    }
    expectArchiveError(() => decodeConfigArchive(buildZip(files)), 'archive-entry-count-exceeded');
  });

  test('aborts on a highly compressible archive that passes the compressed cap but exceeds the aggregate cap', () => {
    const oneMiB = new Uint8Array(MAX_IMPORT_ENTRY_EXPANDED_BYTES);
    const files: Record<string, Uint8Array> = {};
    const entriesNeeded =
      Math.floor(MAX_IMPORT_ARCHIVE_EXPANDED_BYTES / MAX_IMPORT_ENTRY_EXPANDED_BYTES) + 1;
    for (let index = 0; index < entriesNeeded; index += 1) {
      files[`instructions/big-${index}.md`] = oneMiB;
    }
    const zip = buildZip(files);
    expect(zip.byteLength).toBeLessThan(MAX_IMPORT_ZIP_BYTES);
    expectArchiveError(() => decodeConfigArchive(zip), 'archive-expansion-limit-exceeded');
  });

  test('rejects a stored member whose declared sizes are inconsistent', () => {
    const zip = buildStoredZip([
      {
        path: 'agent/reviewer.md',
        content: 'Review.',
        declaredCompressedSize: MAX_IMPORT_ENTRY_EXPANDED_BYTES + 1,
        declaredOriginalSize: 7,
      },
    ]);
    expectArchiveError(() => decodeConfigArchive(zip), 'invalid-archive');
  });

  test('reports a consistently oversized stored member from its allocation size', () => {
    const oversized = MAX_IMPORT_ENTRY_EXPANDED_BYTES + 1;
    const zip = buildStoredZip([
      {
        path: 'agent/huge.md',
        content: 'x',
        declaredCompressedSize: oversized,
        declaredOriginalSize: oversized,
      },
    ]);
    const decoded = decodeConfigArchive(zip);
    const issue = decoded.issues.find(candidate => candidate.code === 'entry-too-large');
    expect(issue?.severity).toBe('error');
    expect(issue?.path).toBe('agent/huge.md');
  });

  test('counts stored members that share one payload against the aggregate cap', () => {
    const entriesNeeded =
      Math.floor(MAX_IMPORT_ARCHIVE_EXPANDED_BYTES / MAX_IMPORT_ENTRY_EXPANDED_BYTES) + 1;
    const entries = Array.from({ length: entriesNeeded }, (_, index) => ({
      path: `agent/shared-${index}.md`,
      content: index === 0 ? new Uint8Array(MAX_IMPORT_ENTRY_EXPANDED_BYTES) : new Uint8Array(0),
      declaredCompressedSize: MAX_IMPORT_ENTRY_EXPANDED_BYTES,
      declaredOriginalSize: MAX_IMPORT_ENTRY_EXPANDED_BYTES,
      declaredOffset: 0,
    }));
    const zip = buildStoredZip(entries);
    expect(zip.byteLength).toBeLessThan(MAX_IMPORT_ZIP_BYTES);
    expectArchiveError(() => decodeConfigArchive(zip), 'archive-expansion-limit-exceeded');
  });

  test('counts directory and junk members against the entry limit before filtering', () => {
    const directories = Array.from({ length: MAX_IMPORT_ARCHIVE_ENTRIES + 1 }, (_, index) => ({
      path: `agent-${index}/`,
      content: '',
    }));
    expectArchiveError(
      () => decodeConfigArchive(buildStoredZip(directories)),
      'archive-entry-count-exceeded'
    );

    const junk: Record<string, string> = {};
    for (let index = 0; index < MAX_IMPORT_ARCHIVE_ENTRIES + 1; index += 1) {
      junk[`__MACOSX/junk-${index}.txt`] = 'junk';
    }
    expectArchiveError(() => decodeConfigArchive(buildZip(junk)), 'archive-entry-count-exceeded');
  });

  test('exposes typed archive error codes', () => {
    const code: ImportArchiveErrorCode = 'invalid-archive';
    expect(new ImportArchiveError(code, 'boom').code).toBe('invalid-archive');
  });
});
