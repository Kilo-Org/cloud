import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { extract as tarExtract } from 'tar-stream';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import {
  OPENCLAW_EXPORT_MAX_FILES,
  OPENCLAW_EXPORT_MAX_FILE_BYTES,
  OPENCLAW_EXPORT_MAX_TOTAL_BYTES,
  OPENCLAW_EXPORT_SKILL_INVENTORY_PATH,
  OpenclawExportError,
  buildOpenclawWorkspaceTarGz,
  buildOpenclawWorkspaceZip,
  collectOpenclawWorkspaceFiles,
  type OpenclawExportEntry,
} from './openclaw-export';

let rootDir: string;
let workspaceDir: string;

function write(relPath: string, content: string | Buffer): void {
  const abs = path.join(workspaceDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  // Canonicalize: os.tmpdir() is a symlink on macOS (/var -> /private/var) and
  // the collector verifies the workspace canonicalizes inside rootDir. The real
  // controller root (~/.openclaw) is already canonical.
  rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-export-')));
  workspaceDir = path.join(rootDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function entriesByPath(entries: OpenclawExportEntry[]): Map<string, Uint8Array> {
  return new Map(entries.map(e => [e.path, e.content]));
}

function inventoryText(entries: OpenclawExportEntry[]): string {
  const content = entriesByPath(entries).get(OPENCLAW_EXPORT_SKILL_INVENTORY_PATH);
  if (!content) throw new Error('expected a skill inventory entry');
  return Buffer.from(content).toString('utf8');
}

async function readTarGz(archive: Uint8Array): Promise<Map<string, Buffer>> {
  const tar = gunzipSync(Buffer.from(archive));
  const out = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    const extract = tarExtract();
    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        out.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.on('error', reject);
      stream.resume();
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
    extract.end(tar);
  });
  return out;
}

async function readZip(archive: Uint8Array, password?: string): Promise<Map<string, Uint8Array>> {
  const reader = new ZipReader(new Uint8ArrayReader(archive), password ? { password } : {});
  const out = new Map<string, Uint8Array>();
  for (const entry of await reader.getEntries()) {
    if (entry.directory) continue;
    const data = await entry.getData!(new Uint8ArrayWriter());
    out.set(entry.filename, data);
  }
  await reader.close();
  return out;
}

describe('collectOpenclawWorkspaceFiles', () => {
  it('collects markdown (persona + memory) and excludes skill/canvas payloads', () => {
    write('USER.md', '# user');
    write('SOUL.md', '# soul');
    write('IDENTITY.md', '# id');
    write('AGENTS.md', '# agents');
    write('TOOLS.md', '# tools'); // exported as-is
    write('MEMORY.md', '# memory');
    write('HEARTBEAT.md', '# hb');
    write('memory/2026-01-01.md', 'note');
    // Excluded payloads:
    write('skills/foo/SKILL.md', '---\nname: foo\n---\n# skill');
    write('canvas/board.json', '{"a":1}');
    write('canvas/notes.md', '# canvas note'); // markdown but under canvas/ -> excluded

    const { entries, totalBytes } = collectOpenclawWorkspaceFiles(rootDir);
    const keys = [...entriesByPath(entries).keys()].sort();

    expect(keys).toEqual([
      'AGENTS.md',
      'HEARTBEAT.md',
      'IDENTITY.md',
      OPENCLAW_EXPORT_SKILL_INVENTORY_PATH,
      'MEMORY.md',
      'SOUL.md',
      'TOOLS.md',
      'USER.md',
      'memory/2026-01-01.md',
    ]);
    expect(keys).not.toContain('skills/foo/SKILL.md');
    expect(keys).not.toContain('canvas/board.json');
    expect(keys).not.toContain('canvas/notes.md');
    expect(totalBytes).toBeGreaterThan(0);
  });

  it('excludes .git, node_modules, OS junk, and non-markdown files', () => {
    write('USER.md', 'u');
    write('.git/config', 'x');
    write('node_modules/pkg/index.js', 'x');
    write('.DS_Store', 'x');
    write('scratch.tmp', 'x');
    write('photo.png', 'binary');

    const { entries, skippedCount } = collectOpenclawWorkspaceFiles(rootDir);
    expect(entries.map(e => e.path)).toEqual(['USER.md']);
    expect(skippedCount).toBeGreaterThan(0);
  });

  it('skips symlinks rather than following them', () => {
    write('USER.md', 'u');
    try {
      fs.symlinkSync(path.join(rootDir, 'openclaw.json'), path.join(workspaceDir, 'link.md'));
    } catch {
      return; // platform without symlink support
    }
    const { entries } = collectOpenclawWorkspaceFiles(rootDir);
    expect(entries.map(e => e.path)).toEqual(['USER.md']);
  });

  it('does not let a user file shadow the generated skill inventory path', () => {
    write(OPENCLAW_EXPORT_SKILL_INVENTORY_PATH, '# user-authored, should be dropped');
    write('skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Does alpha things.\n---\n');

    const { entries } = collectOpenclawWorkspaceFiles(rootDir);
    const matching = entries.filter(e => e.path === OPENCLAW_EXPORT_SKILL_INVENTORY_PATH);
    expect(matching).toHaveLength(1);
    expect(Buffer.from(matching[0].content).toString('utf8')).toContain('Installed skills');
  });

  it('returns empty for a missing or empty workspace', () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-empty-'));
    try {
      // No workspace dir under otherRoot.
      expect(collectOpenclawWorkspaceFiles(otherRoot).entries).toHaveLength(0);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
    // workspace dir exists but is empty.
    expect(collectOpenclawWorkspaceFiles(rootDir).entries).toHaveLength(0);
  });

  it('throws openclaw_export_too_large past the per-file cap', () => {
    write('MEMORY.md', 'x'.repeat(OPENCLAW_EXPORT_MAX_FILE_BYTES + 1));
    try {
      collectOpenclawWorkspaceFiles(rootDir);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenclawExportError);
      expect((error as OpenclawExportError).code).toBe('openclaw_export_too_large');
    }
  });

  it('throws openclaw_export_too_many_files past the file cap', () => {
    for (let i = 0; i <= OPENCLAW_EXPORT_MAX_FILES; i++) {
      write(`memory/note-${i}.md`, 'x');
    }
    try {
      collectOpenclawWorkspaceFiles(rootDir);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenclawExportError);
      expect((error as OpenclawExportError).code).toBe('openclaw_export_too_many_files');
    }
  });
});

describe('installed skill inventory', () => {
  it('is omitted when there are no skills', () => {
    write('USER.md', '# user');
    const { entries } = collectOpenclawWorkspaceFiles(rootDir);
    expect(entries.some(e => e.path === OPENCLAW_EXPORT_SKILL_INVENTORY_PATH)).toBe(false);
  });

  it('lists skills with frontmatter name + description, sorted, with a no-backup notice', () => {
    write('skills/zeta/SKILL.md', '---\nname: zeta\ndescription: "Zeta does Z."\n---\nbody');
    write('skills/alpha/SKILL.md', "---\nname: alpha\ndescription: 'Alpha does A.'\n---\nbody");

    const text = inventoryText(collectOpenclawWorkspaceFiles(rootDir).entries);

    expect(text).toContain('# Installed skills');
    expect(text).toContain('not a backup');
    expect(text).toContain('- **alpha** — Alpha does A.');
    expect(text).toContain('- **zeta** — Zeta does Z.');
    // alpha sorts before zeta
    expect(text.indexOf('**alpha**')).toBeLessThan(text.indexOf('**zeta**'));
  });

  it('falls back to the folder name when frontmatter has no name', () => {
    write('skills/no-meta/SKILL.md', '# just a heading, no frontmatter');
    const text = inventoryText(collectOpenclawWorkspaceFiles(rootDir).entries);
    expect(text).toContain('- **no-meta**');
  });

  it('truncates very long descriptions', () => {
    write('skills/wordy/SKILL.md', `---\nname: wordy\ndescription: ${'x'.repeat(500)}\n---\n`);
    const text = inventoryText(collectOpenclawWorkspaceFiles(rootDir).entries);
    expect(text).toContain('…');
    const line = text.split('\n').find(l => l.includes('**wordy**'))!;
    expect(line.length).toBeLessThan(250);
  });

  it('truncates an over-long skill name', () => {
    const longName = 'n'.repeat(500);
    write('skills/big/SKILL.md', `---\nname: ${longName}\ndescription: ok\n---\n`);
    const text = inventoryText(collectOpenclawWorkspaceFiles(rootDir).entries);
    const line = text.split('\n').find(l => l.startsWith('- **'))!;
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(200);
  });

  it('counts the generated inventory against the total-size cap', () => {
    // Fill the workspace to exactly the total cap with markdown, then a skill
    // whose inventory would push it over -> must fail, not silently exceed.
    const chunk = OPENCLAW_EXPORT_MAX_FILE_BYTES;
    const fullChunks = Math.floor(OPENCLAW_EXPORT_MAX_TOTAL_BYTES / chunk);
    for (let i = 0; i < fullChunks; i++) {
      write(`memory/fill-${i}.md`, 'x'.repeat(chunk));
    }
    const remainder = OPENCLAW_EXPORT_MAX_TOTAL_BYTES % chunk;
    if (remainder > 0) {
      write('memory/fill-rem.md', 'x'.repeat(remainder));
    }
    write('skills/s/SKILL.md', '---\nname: s\ndescription: d\n---\n');

    try {
      collectOpenclawWorkspaceFiles(rootDir);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenclawExportError);
      expect((error as OpenclawExportError).code).toBe('openclaw_export_too_large');
    }
  });

  it('skips an oversized SKILL.md rather than reading it into memory', () => {
    // Larger than the frontmatter read cap (256 KiB).
    const huge = `---\nname: huge\ndescription: big\n---\n${'x'.repeat(400 * 1024)}`;
    write('skills/huge/SKILL.md', huge);
    write('skills/small/SKILL.md', '---\nname: small\ndescription: ok\n---\n');

    const text = inventoryText(collectOpenclawWorkspaceFiles(rootDir).entries);
    expect(text).toContain('- **small** — ok');
    expect(text).not.toContain('**huge**');
  });

  it('ignores a directory without a readable SKILL.md', () => {
    write('skills/notreally/README.md', 'no skill manifest here');
    const { entries } = collectOpenclawWorkspaceFiles(rootDir);
    expect(entries.some(e => e.path === OPENCLAW_EXPORT_SKILL_INVENTORY_PATH)).toBe(false);
  });
});

describe('buildOpenclawWorkspaceTarGz', () => {
  it('round-trips markdown byte-exact, including TOOLS.md and the skill inventory', async () => {
    write('USER.md', '# user');
    write('TOOLS.md', '# kilo tools');
    write('skills/x/SKILL.md', '---\nname: x\ndescription: X.\n---\n');

    const { entries } = collectOpenclawWorkspaceFiles(rootDir);
    const archive = await buildOpenclawWorkspaceTarGz(entries);
    const extracted = await readTarGz(archive);

    expect(extracted.get('USER.md')!.toString()).toBe('# user');
    expect(extracted.get('TOOLS.md')!.toString()).toBe('# kilo tools');
    expect(extracted.get(OPENCLAW_EXPORT_SKILL_INVENTORY_PATH)!.toString()).toContain('**x**');
    expect(extracted.has('skills/x/SKILL.md')).toBe(false);
  });
});

describe('buildOpenclawWorkspaceZip', () => {
  it('produces a plain zip that round-trips byte-exact', async () => {
    write('USER.md', '# user');
    write('memory/m.md', 'a note');

    const { entries } = collectOpenclawWorkspaceFiles(rootDir);
    const archive = await buildOpenclawWorkspaceZip(entries);
    const extracted = await readZip(archive);

    expect(Buffer.from(extracted.get('USER.md')!).toString()).toBe('# user');
    expect(Buffer.from(extracted.get('memory/m.md')!).toString()).toBe('a note');
  });

  it('encrypts with a password and decrypts to identical contents', async () => {
    write('USER.md', '# secret user');
    write('memory/m.md', 'secret memory');

    const { entries } = collectOpenclawWorkspaceFiles(rootDir);
    const archive = await buildOpenclawWorkspaceZip(entries, 'correct horse');
    const extracted = await readZip(archive, 'correct horse');

    expect(Buffer.from(extracted.get('USER.md')!).toString()).toBe('# secret user');
    expect(Buffer.from(extracted.get('memory/m.md')!).toString()).toBe('secret memory');
  });

  it('fails to extract an encrypted zip with the wrong password', async () => {
    write('USER.md', '# secret');
    const { entries } = collectOpenclawWorkspaceFiles(rootDir);
    const archive = await buildOpenclawWorkspaceZip(entries, 'right-password');

    await expect(readZip(archive, 'wrong-password')).rejects.toBeTruthy();
  });
});
