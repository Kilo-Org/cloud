import { execFileSync } from 'node:child_process';
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
  additionalHostCredentials,
  writeGitCredentialRecord,
  writeGitCredentialRecords,
  writeGitCredentialRecordSet,
} from './git-credentials.js';

/** The image's read-only credential helper, which answers Git for a V2 build. */
const helper = path.join(import.meta.dir, '../../../scripts/kilo-git-credential');

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
    // A non-empty directory at the record path fails removal for every user,
    // including a privileged runner, so the failure case does not depend on mode bits.
    const recordPath = gitCredentialRecordPath(home);
    await fs.mkdir(recordPath, { recursive: true });
    await fs.writeFile(path.join(recordPath, 'blocker'), 'x');
    expect(await clearGitCredentialRecord(home)).toBe(false);
  });
});

describe('host credential records', () => {
  const read = () => fs.readFile(gitCredentialRecordPath(home), 'utf8');
  const exists = () =>
    fs.access(gitCredentialRecordPath(home)).then(
      () => true,
      () => false
    );

  it('writes the one record of a single host exactly as a V1 route did', async () => {
    await writeGitCredentialRecord({
      home,
      url: 'https://github.com/acme/repo.git',
      token: 'alias-github',
      platform: 'github',
    });
    expect(await read()).toBe(
      'protocol=https\nhost=github.com\nusername=x-access-token\npassword=alias-github\n'
    );
    expect((await fs.stat(gitCredentialRecordPath(home))).mode & 0o777).toBe(0o600);
  });

  it('writes one record for each host and never one for each repository', async () => {
    await writeGitCredentialRecords({
      home,
      credentials: [
        { url: 'https://github.com/acme/repo.git', token: 'alias-github', platform: 'github' },
        ...additionalHostCredentials([
          {
            url: 'https://gitlab.com/group/sub/project.git',
            token: 'alias-gitlab',
            platform: 'gitlab',
          },
          {
            url: 'https://bitbucket.org/team/repo.git',
            token: 'alias-bitbucket',
            platform: 'bitbucket',
          },
        ]),
      ],
    });
    expect(await read()).toBe(
      'protocol=https\nhost=github.com\nusername=x-access-token\npassword=alias-github\n' +
        '\n' +
        'protocol=https\nhost=gitlab.com\nusername=oauth2\npassword=alias-gitlab\n' +
        '\n' +
        'protocol=https\nhost=bitbucket.org\nusername=x-token-auth\npassword=alias-bitbucket\n'
    );
    expect(await read()).not.toContain('path=');
  });

  it('removes a stale record when no host has a token', async () => {
    await writeGitCredentialRecord({
      home,
      url: 'https://github.com/acme/repo.git',
      token: 'alias-github',
      platform: 'github',
    });
    await writeGitCredentialRecords({
      home,
      credentials: [
        { url: 'https://github.com/acme/repo.git', token: undefined, platform: 'github' },
      ],
    });
    expect(await exists()).toBe(false);
  });

  it('keeps the record when a remote is not HTTPS, as a V1 route did', async () => {
    await writeGitCredentialRecord({
      home,
      url: 'https://github.com/acme/repo.git',
      token: 'alias-github',
      platform: 'github',
    });
    await writeGitCredentialRecord({
      home,
      url: 'ssh://git@github.com/acme/repo.git',
      token: 'alias-ssh',
      platform: 'github',
    });
    expect(await read()).toContain('alias-github');
  });

  it('skips the host whose URL carries no HTTPS record and writes the others', async () => {
    await writeGitCredentialRecords({
      home,
      credentials: [
        { url: 'ssh://git@git.example.com/acme/repo.git', token: 'alias-ssh', platform: 'gitlab' },
        { url: 'https://github.com/acme/repo.git', token: 'alias-github', platform: 'github' },
      ],
    });
    const record = await read();
    expect(record).toContain('host=github.com');
    expect(record).not.toContain('alias-ssh');
  });
});

describe('credential set record', () => {
  it('writes one path-qualified record per member', async () => {
    await writeGitCredentialRecordSet({
      home,
      entries: [
        {
          url: 'https://github.com/acme/one.git',
          token: 'gh-one',
          platform: 'github',
        },
        {
          url: 'https://github.com/acme/two.git',
          token: 'gh-two',
          platform: 'github',
        },
      ],
    });

    const recordPath = gitCredentialRecordPath(home);
    expect(await fs.readFile(recordPath, 'utf8')).toBe(
      'protocol=https\nhost=github.com\npath=acme/one\nusername=x-access-token\npassword=gh-one\n' +
        '\n' +
        'protocol=https\nhost=github.com\npath=acme/two\nusername=x-access-token\npassword=gh-two\n'
    );
    expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600);
  });

  it('qualifies a record by the clone URL path, case included, so the helper answers Git', async () => {
    await writeGitCredentialRecordSet({
      home,
      entries: [
        {
          url: 'https://gitlab.example.com/sub/MyGroup/Repo.git',
          token: 'gl-mixed',
          platform: 'gitlab',
        },
      ],
    });
    const query = (path: string) =>
      execFileSync('sh', [helper, 'get'], {
        input: `protocol=https\nhost=gitlab.example.com\npath=${path}\n\n`,
        env: { PATH: process.env.PATH, SESSION_HOME: home },
        encoding: 'utf8',
      });

    expect(await fs.readFile(gitCredentialRecordPath(home), 'utf8')).toContain(
      'path=sub/MyGroup/Repo\n'
    );
    expect(query('sub/MyGroup/Repo.git')).toContain('password=gl-mixed');
    expect(query('sub/mygroup/repo.git')).not.toContain('password=');
  });

  it('clears the whole set when the last member is removed', async () => {
    await writeGitCredentialRecordSet({
      home,
      entries: [
        {
          url: 'https://github.com/acme/one.git',
          token: 'gh-one',
          platform: 'github',
        },
      ],
    });
    await writeGitCredentialRecordSet({ home, entries: [] });
    expect(
      await fs.access(gitCredentialRecordPath(home)).then(
        () => 'present',
        () => 'missing'
      )
    ).toBe('missing');
  });

  it('refuses a member with no repository path', async () => {
    let threw = false;
    try {
      await writeGitCredentialRecordSet({
        home,
        entries: [
          {
            url: 'https://github.com/',
            token: 'gh-one',
            platform: 'github',
          },
        ],
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
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
