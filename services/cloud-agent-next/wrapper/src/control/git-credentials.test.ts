import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  credentialFreeGitUrl,
  gitCredentialRecordPath,
  gitUrlCarriesCredential,
  normalizeOriginCredential,
  clearGitCredentialRecord,
  writeGitCredentialRecord,
} from './git-credentials.js';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'git-credentials-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('credentialFreeGitUrl', () => {
  it.each([
    ['https://x-access-token:token@github.com/acme/repo.git', 'https://github.com/acme/repo.git'],
    [
      'https://oauth2:token@gitlab.example.com:8443/acme/repo.git',
      'https://gitlab.example.com:8443/acme/repo.git',
    ],
    ['https://github.com/acme/repo.git', 'https://github.com/acme/repo.git'],
  ])('strips HTTP(S) userinfo from %s', (input, expected) => {
    expect(credentialFreeGitUrl(input)).toBe(expected);
  });

  it.each([
    ['ssh://git@github.com/acme/repo.git', 'ssh://git@github.com/acme/repo.git'],
    ['ssh://git:secret@github.com/acme/repo.git', 'ssh://git@github.com/acme/repo.git'],
    ['git@github.com:acme/repo.git', 'git@github.com:acme/repo.git'],
  ])('keeps the SSH login for %s', (input, expected) => {
    expect(credentialFreeGitUrl(input)).toBe(expected);
  });
});

describe('gitUrlCarriesCredential', () => {
  it.each([
    ['https://x-access-token:token@github.com/acme/repo.git', true],
    ['https://x-access-token@github.com/acme/repo.git', true],
    ['https://github.com/acme/repo.git', false],
    ['ssh://git@github.com/acme/repo.git', false],
    ['ssh://git:secret@github.com/acme/repo.git', true],
    ['git@github.com:acme/repo.git', false],
    ['not a url', false],
  ])('reports %s as %s', (input, expected) => {
    expect(gitUrlCarriesCredential(input)).toBe(expected);
  });
});

describe('credential record', () => {
  it('writes the record outside the worktree with owner-only permissions', async () => {
    await writeGitCredentialRecord({
      home,
      url: 'https://gitlab.example.com:8443/acme/repo.git',
      token: 'gl-token',
      platform: 'gitlab',
    });

    const recordPath = gitCredentialRecordPath(home);
    expect(recordPath).toBe(path.join(home, '.local/share/kilo/cloud-agent/git-credentials'));
    expect(await fs.readFile(recordPath, 'utf8')).toBe(
      'protocol=https\nhost=gitlab.example.com:8443\nusername=oauth2\npassword=gl-token\n'
    );
    expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(recordPath))).mode & 0o777).toBe(0o700);
  });

  it('replaces the record and removes it without a token', async () => {
    await writeGitCredentialRecord({
      home,
      url: 'https://github.com/acme/repo.git',
      token: 'first',
      platform: 'github',
    });
    await writeGitCredentialRecord({
      home,
      url: 'https://github.com/acme/repo.git',
      token: 'second',
      platform: 'github',
    });
    expect(await fs.readFile(gitCredentialRecordPath(home), 'utf8')).toContain('password=second');

    await writeGitCredentialRecord({
      home,
      url: 'https://github.com/acme/repo.git',
      token: undefined,
      platform: 'github',
    });
    expect(
      await fs.access(gitCredentialRecordPath(home)).then(
        () => 'present',
        () => 'missing'
      )
    ).toBe('missing');
  });

  it('keeps no record for a remote that cannot carry one', async () => {
    await writeGitCredentialRecord({
      home,
      url: 'ssh://git@github.com/acme/repo.git',
      token: 'ssh-token',
      platform: 'github',
    });
    expect(
      await fs.access(gitCredentialRecordPath(home)).then(
        () => 'present',
        () => 'missing'
      )
    ).toBe('missing');
  });

  it('clears the record before a snapshot', async () => {
    await writeGitCredentialRecord({
      home,
      url: 'https://github.com/acme/repo.git',
      token: 'token',
      platform: 'github',
    });
    expect(await clearGitCredentialRecord(home)).toBe(true);
    expect(
      await fs.access(gitCredentialRecordPath(home)).then(
        () => 'present',
        () => 'missing'
      )
    ).toBe('missing');
    // Nothing to remove is also a clean result.
    expect(await clearGitCredentialRecord(home)).toBe(true);
  });

  it('reports a record it could not remove', async () => {
    await writeGitCredentialRecord({
      home,
      url: 'https://github.com/acme/repo.git',
      token: 'token',
      platform: 'github',
    });
    const directory = path.dirname(gitCredentialRecordPath(home));
    await fs.chmod(directory, 0o500);
    try {
      expect(await clearGitCredentialRecord(home)).toBe(false);
    } finally {
      await fs.chmod(directory, 0o700);
    }
  });
});

describe('normalizeOriginCredential', () => {
  async function normalize(origin: string, written?: { exitCode: number }) {
    const calls: string[][] = [];
    const outcome = await normalizeOriginCredential({
      git: async args => {
        calls.push(args);
        if (args[1] === 'get-url') return { stdout: `${origin}\n`, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: written?.exitCode ?? 0 };
      },
      directory: '/workspace/app',
    });
    return { outcome, calls };
  }

  it('rewrites a token-bearing HTTPS remote to the same URL without the credential', async () => {
    const { outcome, calls } = await normalize(
      'https://x-access-token:stale@github.com/acme/repo.git'
    );
    expect(outcome).toBe('rewritten');
    expect(calls).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/acme/repo.git',
    ]);
  });

  it('leaves an SSH remote with its login alone', async () => {
    const { outcome, calls } = await normalize('ssh://git@github.com/acme/repo.git');
    expect(outcome).toBe('clean');
    expect(calls).toEqual([['remote', 'get-url', 'origin']]);
  });

  it('reports an absent remote and a failed rewrite', async () => {
    const absent = await normalizeOriginCredential({
      git: async () => ({ stdout: '', stderr: 'no such remote', exitCode: 2 }),
      directory: '/workspace/app',
    });
    expect(absent).toBe('absent');
    const failed = await normalize('https://x-access-token:stale@github.com/acme/repo.git', {
      exitCode: 1,
    });
    expect(failed.outcome).toBe('failed');
  });
});
