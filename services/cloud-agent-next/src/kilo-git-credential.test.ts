import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/kilo-git-credential'
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type HelperEnv = {
  GH_TOKEN?: string;
  GITLAB_TOKEN?: string;
  GITLAB_HOST?: string;
  BITBUCKET_TOKEN?: string;
};

function credentialInput(protocol: string, host: string): string {
  return `protocol=${protocol}\nhost=${host}\n\n`;
}

function runHelper(
  action: string | undefined,
  input: string,
  env: HelperEnv = {}
): { status: number | null; stdout: string; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-git-credential-'));
  tempDirs.push(home);
  const result = spawnSync('sh', action === undefined ? [scriptPath] : [scriptPath, action], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      HOME: home,
      GH_TOKEN: undefined,
      GITLAB_TOKEN: undefined,
      GITLAB_HOST: undefined,
      BITBUCKET_TOKEN: undefined,
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, home };
}

function parseCredential(stdout: string): {
  username: string | undefined;
  password: string | undefined;
} {
  let username: string | undefined;
  let password: string | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('username=')) {
      username = line.slice('username='.length);
    } else if (line.startsWith('password=')) {
      password = line.slice('password='.length);
    }
  }
  return { username, password };
}

function expectPassword(actual: string | undefined, expected: string): void {
  if (actual !== expected) {
    throw new Error('password did not match the provided token');
  }
}

describe('kilo-git-credential', () => {
  it('returns GitHub credentials including a capability token', () => {
    const token = 'kgh2.cap';
    const result = runHelper('get', credentialInput('https', 'github.com'), { GH_TOKEN: token });
    expect(result.status).toBe(0);
    const parsed = parseCredential(result.stdout);
    expect(parsed.username).toBe('x-access-token');
    expectPassword(parsed.password, token);
  });

  it('returns GitLab credentials for gitlab.com', () => {
    const token = 'kgl2.cap';
    const result = runHelper('get', credentialInput('https', 'gitlab.com'), {
      GITLAB_TOKEN: token,
    });
    expect(result.status).toBe(0);
    const parsed = parseCredential(result.stdout);
    expect(parsed.username).toBe('oauth2');
    expectPassword(parsed.password, token);
  });

  it('returns GitLab credentials for a custom GITLAB_HOST and ignores gitlab.com', () => {
    const token = 'kgl2.custom';
    const env = { GITLAB_TOKEN: token, GITLAB_HOST: 'gitlab.example.com' };
    const custom = runHelper('get', credentialInput('https', 'gitlab.example.com'), env);
    expect(custom.status).toBe(0);
    const parsed = parseCredential(custom.stdout);
    expect(parsed.username).toBe('oauth2');
    expectPassword(parsed.password, token);

    const defaultHost = runHelper('get', credentialInput('https', 'gitlab.com'), env);
    expect(defaultHost.status).toBe(0);
    expect(defaultHost.stdout).toBe('');
  });

  it('matches GITLAB_HOST and requested host when either includes a port', () => {
    const token = 'kgl2.port';
    const env = { GITLAB_TOKEN: token, GITLAB_HOST: 'gitlab.example.com:8443' };
    const requestedWithPort = runHelper(
      'get',
      credentialInput('https', 'gitlab.example.com:8443'),
      env
    );
    expect(requestedWithPort.status).toBe(0);
    const parsedRequested = parseCredential(requestedWithPort.stdout);
    expect(parsedRequested.username).toBe('oauth2');
    expectPassword(parsedRequested.password, token);

    const requestedWithoutPort = runHelper(
      'get',
      credentialInput('https', 'gitlab.example.com'),
      env
    );
    expect(requestedWithoutPort.status).toBe(0);
    const parsedBare = parseCredential(requestedWithoutPort.stdout);
    expect(parsedBare.username).toBe('oauth2');
    expectPassword(parsedBare.password, token);
  });

  it('accepts GITLAB_HOST with a scheme and path', () => {
    const token = 'kgl2.scheme';
    const result = runHelper('get', credentialInput('https', 'gitlab.example.com'), {
      GITLAB_TOKEN: token,
      GITLAB_HOST: 'https://gitlab.example.com/gitlab',
    });
    expect(result.status).toBe(0);
    const parsed = parseCredential(result.stdout);
    expect(parsed.username).toBe('oauth2');
    expectPassword(parsed.password, token);
  });

  it('returns Bitbucket credentials', () => {
    const token = 'kbb1.cap';
    const result = runHelper('get', credentialInput('https', 'bitbucket.org'), {
      BITBUCKET_TOKEN: token,
    });
    expect(result.status).toBe(0);
    const parsed = parseCredential(result.stdout);
    expect(parsed.username).toBe('x-token-auth');
    expectPassword(parsed.password, token);
  });

  it('prints nothing for an unmatched host', () => {
    const result = runHelper('get', credentialInput('https', 'example.com'), {
      GH_TOKEN: 'kgh2.unused',
      GITLAB_TOKEN: 'kgl2.unused',
      BITBUCKET_TOKEN: 'kbb1.unused',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('prints nothing when the matching https token is missing', () => {
    const result = runHelper('get', credentialInput('https', 'github.com'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('prints nothing for http', () => {
    const result = runHelper('get', credentialInput('http', 'github.com'), {
      GH_TOKEN: 'kgh2.unused',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each(['store', 'erase', 'unknown'] as const)('%s exits 0 without writing files', action => {
    const result = runHelper(action, credentialInput('https', 'github.com'), {
      GH_TOKEN: 'kgh2.unused',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(fs.existsSync(path.join(result.home, '.git-credentials'))).toBe(false);
    expect(fs.readdirSync(result.home)).toEqual([]);
  });
});
