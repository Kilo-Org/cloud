import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLogArchive } from './log-archive-files.js';
import { rememberLogSecrets } from './log-redaction.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const remove of cleanup.splice(0)) remove();
});

describe('private log archive collection', () => {
  it('retains an explicit truncation manifest and excludes manifests found in log directories', () => {
    const directory = mkdtempSync(join(tmpdir(), 'archive-manifest-'));
    cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
    const logs = join(directory, 'logs');
    mkdirSync(logs);
    writeFileSync(join(logs, 'kilo.log'), 'useful diagnostic\n');
    writeFileSync(join(logs, 'TRUNCATED.txt'), 'unselected manifest\n');
    const manifest = '[TRUNCATED: additional log files omitted by the total capture limit]\n';
    writeFileSync(join(directory, 'TRUNCATED.txt'), manifest);
    const archive = prepareLogArchive([logs, { directory, name: 'TRUNCATED.txt' }]);
    expect(archive).toBeDefined();
    if (!archive) throw new Error('Expected a diagnostic archive');
    cleanup.push(archive.cleanup);
    expect(readFileSync(join(archive.directory, 'TRUNCATED.txt'), 'utf8')).toBe(manifest);
    expect(existsSync(join(archive.directory, 'logs', 'TRUNCATED.txt'))).toBe(false);
    expect(readFileSync(join(archive.directory, 'logs', 'kilo.log'), 'utf8')).toBe(
      'useful diagnostic\n'
    );
  });

  it('redacts current and historical credentials and excludes non-logs, binary files and links', () => {
    const directory = mkdtempSync(join(tmpdir(), 'archive-input-'));
    cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
    const logs = join(directory, 'logs');
    mkdirSync(logs);
    const oldSecret = 'synthetic-log-canary/old+12345';
    const newSecret = 'synthetic-log-canary/new+67890';
    rememberLogSecrets({ API_TOKEN: oldSecret });
    rememberLogSecrets({ PROFILE_VALUE: newSecret }, ['PROFILE_VALUE']);
    const variants = [
      oldSecret,
      newSecret,
      encodeURIComponent(oldSecret),
      Buffer.from(oldSecret).toString('base64'),
      Buffer.from(newSecret).toString('hex'),
    ];
    writeFileSync(join(logs, 'kilo.log'), `useful diagnostic\n${variants.join('\n')}`);
    writeFileSync(join(logs, 'credentials.json'), 'excluded-content');
    writeFileSync(join(logs, 'binary.log'), Buffer.from([0, 1, 2]));
    symlinkSync(join(logs, 'credentials.json'), join(logs, 'linked.log'));
    const archive = prepareLogArchive([logs]);
    expect(archive).toBeDefined();
    if (!archive) return;
    cleanup.push(archive.cleanup);
    const text = readFileSync(join(archive.directory, 'logs', 'kilo.log'), 'utf8');
    expect(text.includes('useful diagnostic')).toBe(true);
    expect(variants.some(secret => text.includes(secret))).toBe(false);
    expect(text.includes('[REDACTED]')).toBe(true);
    for (const name of ['credentials.json', 'binary.log', 'linked.log']) {
      expect(existsSync(join(archive.directory, 'logs', name))).toBe(false);
    }
  });

  it('suppresses oversized lines before pattern redaction and retains later diagnostics', () => {
    const directory = mkdtempSync(join(tmpdir(), 'archive-lines-'));
    cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
    writeFileSync(
      join(directory, 'crafted.log'),
      `${'-'.repeat(8 * 1024 * 1024 - 128)}\nuseful diagnostic\nAuthorization: Bearer synthetic-archive-secret`
    );
    const archive = prepareLogArchive([join(directory, 'crafted.log')]);
    expect(archive).toBeDefined();
    if (!archive) return;
    cleanup.push(archive.cleanup);
    const text = readFileSync(join(archive.directory, 'crafted.log'), 'utf8');
    expect(text).toContain('[Log line suppressed: length limit]');
    expect(text).toContain('useful diagnostic');
    expect(text).not.toContain('synthetic-archive-secret');
    expect(text.length).toBeLessThan(256);
  });

  it('excludes oversized logs and symlinked parent directories', () => {
    const directory = mkdtempSync(join(tmpdir(), 'archive-size-'));
    cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
    writeFileSync(join(directory, 'large.log'), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    mkdirSync(join(directory, 'real'));
    writeFileSync(join(directory, 'real', 'secret.log'), 'excluded');
    symlinkSync(join(directory, 'real'), join(directory, 'linked'));
    expect(
      prepareLogArchive([join(directory, 'large.log'), { directory, name: 'linked/secret.log' }])
    ).toBeUndefined();
  });

  it('bounds each log tail while preserving the latest diagnostics in every file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'archive-line-count-'));
    cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
    for (const name of ['first.log', 'second.log'])
      writeFileSync(join(directory, name), 'diagnostic\n'.repeat(10_000) + `latest ${name}\n`);
    const archive = prepareLogArchive([
      join(directory, 'first.log'),
      join(directory, 'second.log'),
    ]);
    if (!archive) throw new Error('Expected a diagnostic archive');
    cleanup.push(archive.cleanup);
    const text = ['first.log', 'second.log']
      .map(name => readFileSync(join(archive.directory, name), 'utf8'))
      .join('\n');
    expect(text.match(/^diagnostic$/gm)?.length).toBe(2046);
    expect(text).toContain('latest first.log');
    expect(text).toContain('latest second.log');
    expect(text).toContain('[TRUNCATED: retained latest log lines within the archive line limit]');
  });

  it('truncates a newline-dense maximum-size log before secret filtering', () => {
    const directory = mkdtempSync(join(tmpdir(), 'archive-dense-lines-'));
    cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
    writeFileSync(join(directory, 'dense.log'), '\n'.repeat(8 * 1024 * 1024));
    const archive = prepareLogArchive([join(directory, 'dense.log')]);
    if (!archive) throw new Error('Expected a diagnostic archive');
    cleanup.push(archive.cleanup);
    const text = readFileSync(join(archive.directory, 'dense.log'), 'utf8');
    expect(text).toContain('[TRUNCATED: retained latest log lines within the archive line limit]');
    expect(text.length).toBeLessThan(32 * 1024);
  });
});
