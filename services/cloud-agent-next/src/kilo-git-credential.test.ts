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

type HelperOptions = {
  home?: string;
  sessionHome?: string;
};

type StoredCredential = {
  protocol?: string;
  host: string;
  username?: string;
  password?: string;
};

function createHelperHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-git-credential-'));
  tempDirs.push(home);
  return home;
}

function writeCredentialRecord(home: string, credential: StoredCredential): string {
  const credentialFile = path.join(
    home,
    '.local',
    'share',
    'kilo',
    'cloud-agent',
    'git-credentials'
  );
  fs.mkdirSync(path.dirname(credentialFile), { recursive: true });
  fs.writeFileSync(
    credentialFile,
    `${Object.entries(credential)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`
  );
  return credentialFile;
}

function credentialInput(protocol: string, host: string): string {
  return `protocol=${protocol}\nhost=${host}\n\n`;
}

function runHelper(
  action: string | undefined,
  input: string,
  env: HelperEnv = {},
  options: HelperOptions = {}
): { status: number | null; stdout: string; home: string } {
  const home = options.home ?? createHelperHome();
  const result = spawnSync('sh', action === undefined ? [scriptPath] : [scriptPath, action], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      HOME: home,
      SESSION_HOME: options.sessionHome,
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

  it('matches GITLAB_HOST and requested host including their port', () => {
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
    expect(requestedWithoutPort.stdout).toBe('');
  });

  it('does not return a GitHub token for a different port', () => {
    const result = runHelper('get', credentialInput('https', 'github.com:8443'), {
      GH_TOKEN: 'kgh2.unused',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
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

  it('prefers authoritative GitHub credentials over an overridden GH_TOKEN', () => {
    const home = createHelperHome();
    const token = 'kgh2.authoritative';
    writeCredentialRecord(home, {
      protocol: 'https',
      host: 'github.com',
      username: 'x-access-token',
      password: token,
    });

    const result = runHelper(
      'get',
      credentialInput('https', 'github.com'),
      { GH_TOKEN: 'kgh2.profile-override' },
      { home }
    );

    expect(result.status).toBe(0);
    const parsed = parseCredential(result.stdout);
    expect(parsed.username).toBe('x-access-token');
    expectPassword(parsed.password, token);
  });

  it('prefers authoritative GitLab credentials over conflicting GitLab host and token overrides', () => {
    const home = createHelperHome();
    const host = 'gitlab.repository.example.com:8443';
    const token = 'kgl2.authoritative';
    writeCredentialRecord(home, {
      protocol: 'https',
      host,
      username: 'oauth2',
      password: token,
    });

    const result = runHelper(
      'get',
      credentialInput('https', host),
      {
        GITLAB_HOST: 'gitlab.profile.example.com',
        GITLAB_TOKEN: 'kgl2.profile-override',
      },
      { home }
    );

    expect(result.status).toBe(0);
    const parsed = parseCredential(result.stdout);
    expect(parsed.username).toBe('oauth2');
    expectPassword(parsed.password, token);
  });

  it.each([
    {
      host: 'bitbucket.org',
      username: 'x-token-auth',
      token: 'kbb1.authoritative',
      env: { BITBUCKET_TOKEN: 'kbb1.profile-override' },
    },
    {
      host: 'git.example.com:8443',
      username: 'x-access-token',
      token: 'generic.authoritative',
      env: {},
    },
  ])('returns authoritative $username credentials for $host', ({ host, username, token, env }) => {
    const home = createHelperHome();
    writeCredentialRecord(home, {
      protocol: 'https',
      host,
      username,
      password: token,
    });

    const result = runHelper('get', credentialInput('https', host), env, { home });

    expect(result.status).toBe(0);
    const parsed = parseCredential(result.stdout);
    expect(parsed.username).toBe(username);
    expectPassword(parsed.password, token);
  });

  it('requires the authoritative host to match the requested host and port exactly', () => {
    const home = createHelperHome();
    const host = 'gitlab.example.com:8443';
    const token = 'kgl2.authoritative-port';
    writeCredentialRecord(home, {
      protocol: 'https',
      host,
      username: 'oauth2',
      password: token,
    });

    const matching = runHelper('get', credentialInput('https', host), {}, { home });
    expect(matching.status).toBe(0);
    expectPassword(parseCredential(matching.stdout).password, token);

    const differentPort = runHelper(
      'get',
      credentialInput('https', 'gitlab.example.com:9443'),
      {},
      { home }
    );
    expect(differentPort.status).toBe(0);
    expect(differentPort.stdout).toBe('');

    const withoutPort = runHelper(
      'get',
      credentialInput('https', 'gitlab.example.com'),
      {},
      {
        home,
      }
    );
    expect(withoutPort.status).toBe(0);
    expect(withoutPort.stdout).toBe('');
  });

  it('retains environment fallback for another host without exposing the authoritative credential', () => {
    const home = createHelperHome();
    const repositoryToken = 'kgh2.authoritative';
    const fallbackToken = 'kgl2.environment-fallback';
    writeCredentialRecord(home, {
      protocol: 'https',
      host: 'github.com',
      username: 'x-access-token',
      password: repositoryToken,
    });

    const result = runHelper(
      'get',
      credentialInput('https', 'gitlab.com'),
      { GITLAB_TOKEN: fallbackToken },
      { home }
    );

    expect(result.status).toBe(0);
    const parsed = parseCredential(result.stdout);
    expect(parsed.username).toBe('oauth2');
    expectPassword(parsed.password, fallbackToken);
    expect(result.stdout).not.toContain(repositoryToken);
  });

  it('prefers SESSION_HOME over HOME when locating authoritative credentials', () => {
    const home = createHelperHome();
    const sessionHome = createHelperHome();
    const sessionToken = 'kgh2.session-home';
    writeCredentialRecord(home, {
      protocol: 'https',
      host: 'github.com',
      username: 'x-access-token',
      password: 'kgh2.home',
    });
    writeCredentialRecord(sessionHome, {
      protocol: 'https',
      host: 'github.com',
      username: 'x-access-token',
      password: sessionToken,
    });

    const result = runHelper(
      'get',
      credentialInput('https', 'github.com'),
      { GH_TOKEN: 'kgh2.profile-override' },
      { home, sessionHome }
    );

    expect(result.status).toBe(0);
    expectPassword(parseCredential(result.stdout).password, sessionToken);
  });

  it('observes rotated authoritative credentials while the inherited token remains stale', () => {
    const home = createHelperHome();
    const env = { GH_TOKEN: 'kgh2.stale-inherited' };
    const initialToken = 'kgh2.initial';
    const rotatedToken = 'kgh2.rotated';
    writeCredentialRecord(home, {
      protocol: 'https',
      host: 'github.com',
      username: 'x-access-token',
      password: initialToken,
    });

    const initial = runHelper('get', credentialInput('https', 'github.com'), env, { home });
    expect(initial.status).toBe(0);
    expectPassword(parseCredential(initial.stdout).password, initialToken);

    writeCredentialRecord(home, {
      protocol: 'https',
      host: 'github.com',
      username: 'x-access-token',
      password: rotatedToken,
    });

    const rotated = runHelper('get', credentialInput('https', 'github.com'), env, { home });
    expect(rotated.status).toBe(0);
    expectPassword(parseCredential(rotated.stdout).password, rotatedToken);
  });

  it.each([
    {
      description: 'a missing protocol',
      credential: {
        host: 'github.com',
        username: 'x-access-token',
        password: 'kgh2.authoritative',
      },
    },
    {
      description: 'a non-HTTPS protocol',
      credential: {
        protocol: 'http',
        host: 'github.com',
        username: 'x-access-token',
        password: 'kgh2.authoritative',
      },
    },
    {
      description: 'a missing username',
      credential: {
        protocol: 'https',
        host: 'github.com',
        password: 'kgh2.authoritative',
      },
    },
    {
      description: 'an empty username',
      credential: {
        protocol: 'https',
        host: 'github.com',
        username: '',
        password: 'kgh2.authoritative',
      },
    },
    {
      description: 'a missing password',
      credential: {
        protocol: 'https',
        host: 'github.com',
        username: 'x-access-token',
      },
    },
    {
      description: 'an empty password',
      credential: {
        protocol: 'https',
        host: 'github.com',
        username: 'x-access-token',
        password: '',
      },
    },
  ])('fails closed for a matching credential record with $description', ({ credential }) => {
    const home = createHelperHome();
    writeCredentialRecord(home, credential);

    const result = runHelper(
      'get',
      credentialInput('https', 'github.com'),
      { GH_TOKEN: 'kgh2.profile-override' },
      { home }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('fails closed for malformed matching credential records', () => {
    const home = createHelperHome();
    const credentialFile = writeCredentialRecord(home, {
      protocol: 'https',
      host: 'github.com',
      username: 'x-access-token',
      password: 'kgh2.authoritative',
    });
    fs.appendFileSync(credentialFile, 'unexpected=value\n');

    const result = runHelper(
      'get',
      credentialInput('https', 'github.com'),
      { GH_TOKEN: 'kgh2.profile-override' },
      { home }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('parses authoritative token metacharacters literally without executing them', () => {
    const home = createHelperHome();
    const marker = path.join(home, 'credential-executed');
    const token = `kgh2.$(touch ${marker});\`touch ${marker}\`;'"\\$&|=*?[]=literal`;
    writeCredentialRecord(home, {
      protocol: 'https',
      host: 'github.com',
      username: 'x-access-token',
      password: token,
    });

    const result = runHelper('get', credentialInput('https', 'github.com'), {}, { home });

    expect(result.status).toBe(0);
    expectPassword(parseCredential(result.stdout).password, token);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('does not return authoritative credentials for HTTP requests', () => {
    const home = createHelperHome();
    writeCredentialRecord(home, {
      protocol: 'https',
      host: 'github.com',
      username: 'x-access-token',
      password: 'kgh2.authoritative',
    });

    const result = runHelper(
      'get',
      credentialInput('http', 'github.com'),
      { GH_TOKEN: 'kgh2.profile-override' },
      { home }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
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
