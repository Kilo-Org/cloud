import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { extract as tarExtract } from 'tar-stream';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import {
  OPENCLAW_EXPORT_MAX_FILES,
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
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-export-'));
  workspaceDir = path.join(rootDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function entriesByPath(entries: OpenclawExportEntry[]): Map<string, Uint8Array> {
  return new Map(entries.map(e => [e.path, e.content]));
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
  it('collects the full workspace tree with workspace-relative paths', () => {
    write('USER.md', '# user');
    write('SOUL.md', '# soul');
    write('IDENTITY.md', '# id');
    write('AGENTS.md', '# agents');
    write('TOOLS.md', '# tools'); // exported as-is
    write('MEMORY.md', '# memory');
    write('HEARTBEAT.md', '# hb');
    write('memory/2026-01-01.md', 'note');
    write('skills/foo/SKILL.md', '# skill');
    write('canvas/board.json', '{"a":1}');

    const { entries, totalBytes } = collectOpenclawWorkspaceFiles(workspaceDir);
    const map = entriesByPath(entries);

    expect([...map.keys()].sort()).toEqual([
      'AGENTS.md',
      'HEARTBEAT.md',
      'IDENTITY.md',
      'MEMORY.md',
      'SOUL.md',
      'TOOLS.md',
      'USER.md',
      'canvas/board.json',
      'memory/2026-01-01.md',
      'skills/foo/SKILL.md',
    ]);
    expect(totalBytes).toBeGreaterThan(0);
  });

  it('preserves binary content byte-for-byte', async () => {
    const bin = Buffer.from([0, 1, 2, 253, 254, 255, 0, 42]);
    write('canvas/image.bin', bin);
    const { entries } = collectOpenclawWorkspaceFiles(workspaceDir);
    const map = entriesByPath(entries);
    expect(Buffer.from(map.get('canvas/image.bin')!)).toEqual(bin);
  });

  it('excludes .git, node_modules, OS junk, and transient files', () => {
    write('USER.md', 'u');
    write('.git/config', 'x');
    write('node_modules/pkg/index.js', 'x');
    write('.DS_Store', 'x');
    write('scratch.tmp', 'x');

    const { entries, skippedCount } = collectOpenclawWorkspaceFiles(workspaceDir);
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
    const { entries } = collectOpenclawWorkspaceFiles(workspaceDir);
    expect(entries.map(e => e.path)).toEqual(['USER.md']);
  });

  it('returns empty for a missing or empty workspace', () => {
    expect(collectOpenclawWorkspaceFiles(path.join(rootDir, 'nope')).entries).toHaveLength(0);
    expect(collectOpenclawWorkspaceFiles(workspaceDir).entries).toHaveLength(0);
  });

  it('throws openclaw_export_too_many_files past the file cap', () => {
    for (let i = 0; i <= OPENCLAW_EXPORT_MAX_FILES; i++) {
      write(`memory/note-${i}.md`, 'x');
    }
    try {
      collectOpenclawWorkspaceFiles(workspaceDir);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenclawExportError);
      expect((error as OpenclawExportError).code).toBe('openclaw_export_too_many_files');
    }
  });
});

describe('buildOpenclawWorkspaceTarGz', () => {
  it('produces a gzip tar that round-trips byte-exact, including TOOLS.md and binaries', async () => {
    write('USER.md', '# user');
    write('TOOLS.md', '# kilo tools');
    const bin = Buffer.from([10, 0, 200, 255, 7]);
    write('skills/x/data.bin', bin);

    const { entries } = collectOpenclawWorkspaceFiles(workspaceDir);
    const archive = await buildOpenclawWorkspaceTarGz(entries);
    const extracted = await readTarGz(archive);

    expect(extracted.get('USER.md')!.toString()).toBe('# user');
    expect(extracted.get('TOOLS.md')!.toString()).toBe('# kilo tools');
    expect(extracted.get('skills/x/data.bin')!).toEqual(bin);
  });
});

describe('buildOpenclawWorkspaceZip', () => {
  it('produces a plain zip that round-trips byte-exact', async () => {
    write('USER.md', '# user');
    const bin = Buffer.from([1, 2, 3, 0, 255]);
    write('canvas/c.bin', bin);

    const { entries } = collectOpenclawWorkspaceFiles(workspaceDir);
    const archive = await buildOpenclawWorkspaceZip(entries);
    const extracted = await readZip(archive);

    expect(Buffer.from(extracted.get('USER.md')!).toString()).toBe('# user');
    expect(Buffer.from(extracted.get('canvas/c.bin')!)).toEqual(bin);
  });

  it('encrypts with a password and decrypts to identical contents', async () => {
    write('USER.md', '# secret user');
    write('memory/m.md', 'secret memory');

    const { entries } = collectOpenclawWorkspaceFiles(workspaceDir);
    const archive = await buildOpenclawWorkspaceZip(entries, 'correct horse');
    const extracted = await readZip(archive, 'correct horse');

    expect(Buffer.from(extracted.get('USER.md')!).toString()).toBe('# secret user');
    expect(Buffer.from(extracted.get('memory/m.md')!).toString()).toBe('secret memory');
  });

  it('fails to extract an encrypted zip with the wrong password', async () => {
    write('USER.md', '# secret');
    const { entries } = collectOpenclawWorkspaceFiles(workspaceDir);
    const archive = await buildOpenclawWorkspaceZip(entries, 'right-password');

    await expect(readZip(archive, 'wrong-password')).rejects.toBeTruthy();
  });
});
