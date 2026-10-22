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
});
