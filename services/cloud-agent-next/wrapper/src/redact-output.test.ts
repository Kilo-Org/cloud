import { describe, expect, it } from 'bun:test';
import { createOutputRedactor, createSecretRedactor, redactSecrets } from './redact-output';

describe('redactSecrets', () => {
  it('redacts bearer tokens in Authorization headers', () => {
    expect(redactSecrets('Authorization: Bearer ghp_abc123def456')).toBe(
      'Authorization: Bearer [REDACTED]'
    );
  });

  it('redacts basic auth in Authorization headers', () => {
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe(
      'Authorization: Basic [REDACTED]'
    );
  });

  it('redacts URL-embedded credentials', () => {
    expect(redactSecrets('https://user:password@example.com/repo.git')).toBe(
      'https://[REDACTED]@example.com/repo.git'
    );
    expect(
      redactSecrets('Cloning into https://x-access-token:ghs_token@github.com/owner/repo')
    ).toBe('Cloning into https://[REDACTED]@github.com/owner/repo');
    expect(redactSecrets('https://single-token@example.com/repo.git')).toBe(
      'https://[REDACTED]@example.com/repo.git'
    );
  });

  it('redacts Cookie headers', () => {
    expect(redactSecrets('Cookie: session=abc123; csrf=xyz')).toBe('Cookie: [REDACTED]');
  });

  it('redacts KEY=VALUE where key contains secret-like names', () => {
    expect(redactSecrets('SECRET_VALUE=env-secret')).toBe('SECRET_VALUE=[REDACTED]');
    expect(redactSecrets('GITHUB_TOKEN=ghp_abc123')).toBe('GITHUB_TOKEN=[REDACTED]');
    expect(redactSecrets('export DATABASE_PASSWORD=hunter2')).toBe(
      'export DATABASE_PASSWORD=[REDACTED]'
    );
    expect(redactSecrets('API_KEY=sk-abc123')).toBe('API_KEY=[REDACTED]');
    expect(redactSecrets('DATABASE_PASSWORD="secret with spaces"')).toBe(
      'DATABASE_PASSWORD=[REDACTED]'
    );
  });

  it('does not redact non-secret KEY=VALUE pairs', () => {
    expect(redactSecrets('PATH=/usr/local/bin')).toBe('PATH=/usr/local/bin');
    expect(redactSecrets('NODE_ENV=production')).toBe('NODE_ENV=production');
    expect(redactSecrets('HOME=/home/user')).toBe('HOME=/home/user');
  });

  it('redacts CLI flags with secret values', () => {
    expect(redactSecrets('private-tool --token argv-secret')).toBe(
      'private-tool --token [REDACTED]'
    );
    expect(redactSecrets('curl --password mypass https://example.com')).toBe(
      'curl --password [REDACTED] https://example.com'
    );
    expect(redactSecrets('tool --api-key=sk_abc123')).toBe('tool --api-key=[REDACTED]');
    expect(redactSecrets("tool --github-token 'secret with spaces'")).toBe(
      'tool --github-token [REDACTED]'
    );
  });

  it('redacts multiple secrets in multi-line output', () => {
    const input = [
      'bare-unlabeled-token',
      'https://user:url-secret@example.com/repo.git',
      'Authorization: Bearer bearer-secret',
      'Cookie: session=cookie-secret',
      'SECRET_VALUE=env-secret',
    ].join('\n');

    const result = redactSecrets(input);
    expect(result).not.toContain('url-secret');
    expect(result).not.toContain('bearer-secret');
    expect(result).not.toContain('cookie-secret');
    expect(result).not.toContain('env-secret');
    expect(result).toContain('https://[REDACTED]@example.com/repo.git');
    expect(result).toContain('Authorization: Bearer [REDACTED]');
    expect(result).toContain('Cookie: [REDACTED]');
    expect(result).toContain('SECRET_VALUE=[REDACTED]');
  });

  it.each(['KILO_AUTH_CONTENT', 'KILO_CONFIG_CONTENT', 'OPENCODE_CONFIG_CONTENT'])(
    'redacts a %s environment dump',
    name => {
      expect(
        redactSecrets(`${name}={"provider":{"apiKey":"fake-config-token","model":"test"}}`)
      ).toBe(`${name}=[REDACTED]`);
    }
  );

  it('leaves non-secret content unchanged', () => {
    expect(redactSecrets('npm install')).toBe('npm install');
    expect(redactSecrets('added 42 packages in 3s')).toBe('added 42 packages in 3s');
    expect(redactSecrets('Error: ENOENT: no such file or directory')).toBe(
      'Error: ENOENT: no such file or directory'
    );
  });
});

describe('known setup secret redaction', () => {
  const environment = {
    KILO_AUTH_CONTENT: JSON.stringify({
      kilo: {
        type: 'oauth',
        key: 'fake-auth-key',
        access: 'fake-access-token',
        refresh: 'fake-refresh-token',
      },
    }),
    KILO_CONFIG_CONTENT: JSON.stringify({
      provider: {
        kilo: {
          options: {
            apiKey: 'fake-config-key',
            headers: { Authorization: 'Bearer fake-header-token' },
          },
        },
      },
    }),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      provider: { test: { options: { apiKey: 'fake-opencode-key' } } },
    }),
    CUSTOM_API_KEY: 'fake-unlabeled-key',
    NODE_ENV: 'development',
  };
  const tokens = [
    'fake-auth-key',
    'fake-access-token',
    'fake-refresh-token',
    'fake-config-key',
    'fake-header-token',
    'fake-opencode-key',
    'fake-unlabeled-key',
  ];

  it('removes known tokens from reformatted JSON, bare output, and authorization values', () => {
    const redact = createSecretRedactor(environment);
    const output = [
      ...Object.values(environment).map(value => {
        try {
          return JSON.stringify(JSON.parse(value), null, 2);
        } catch {
          return value;
        }
      }),
      ...tokens,
      'installed packages',
    ].join('\n');
    const result = redact(output);
    for (const token of tokens) expect(result).not.toContain(token);
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('installed packages');
    expect(result).toContain('development');
  });

  it('retains secrets from wrapper, attachment, and rebuilt worktree configurations', () => {
    const configs = ['wrapper-auth-secret', 'attachment-auth-secret', 'guest-worktree-alias'].map(
      key => ({
        KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key } }),
      })
    );
    const redact = createSecretRedactor(configs[0], [configs[1], configs[2]]);
    expect(redact('wrapper-auth-secret attachment-auth-secret guest-worktree-alias ready')).toBe(
      '[REDACTED] [REDACTED] [REDACTED] ready'
    );
  });

  it('redacts every MCP header and local environment value regardless of its name', () => {
    const remoteValue = 'remote-arbitrary-header-secret';
    const localValue = 'local-arbitrary-environment-secret';
    const redact = createSecretRedactor({
      KILO_CONFIG_CONTENT: JSON.stringify({
        mcp: {
          remote: {
            type: 'remote',
            url: 'https://mcp.example.test',
            headers: { 'X-Service-Auth': remoteValue },
          },
          local: {
            type: 'local',
            command: ['local-mcp'],
            environment: { VALUE: localValue },
          },
        },
      }),
    });

    const output = redact(`${remoteValue} ${localValue}`);
    expect(output).not.toContain(remoteValue);
    expect(output).not.toContain(localValue);
    expect(output).toBe('[REDACTED] [REDACTED]');
  });

  it.each([1, 7, 2049])(
    'redacts split chunks of %i characters on interleaved output streams',
    chunkSize => {
      const events: string[] = [];
      const output = createOutputRedactor(createSecretRedactor(environment), text =>
        events.push(text)
      );
      const stdout = `${Object.entries(environment)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n')}\n${tokens.join('\n')}`;
      const stderr = 'warning fake-header-token\n';
      for (let index = 0; index < stdout.length; index += chunkSize) {
        output.onOutput('stdout', stdout.slice(index, index + chunkSize));
        if (index < stderr.length)
          output.onOutput('stderr', stderr.slice(index, index + chunkSize));
      }
      output.flush();
      const result = events.join('');
      for (const token of tokens) expect(result).not.toContain(token);
      expect(result).toContain('NODE_ENV=development');
      expect(result).toContain('warning [REDACTED]');
      expect(events.every(event => event.length <= 2048)).toBe(true);
    }
  );

  it('redacts multiline and JSON-escaped secret values', () => {
    const secret = 'fake-line-one\nfake-line-two"\\end';
    const events: string[] = [];
    const output = createOutputRedactor(
      createSecretRedactor({ KILO_CONFIG_CONTENT: JSON.stringify({ apiKey: secret }) }),
      text => events.push(text)
    );
    output.onOutput('stdout', `API_KEY=${secret}\n`);
    output.onOutput('stderr', JSON.stringify({ copied: secret }, null, 2));
    output.flush();
    const result = events.join('');
    expect(result).not.toContain('fake-line-one');
    expect(result).not.toContain('fake-line-two');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts JSON-serialized environment objects containing escaped auth configuration', () => {
    const environment = {
      KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: 'fake-quoted"key\\value' } }),
    };
    const result = createSecretRedactor(environment)(JSON.stringify(environment));
    expect(result).not.toContain('fake-quoted');
    expect(result).toContain('[REDACTED]');
  });

  it('drops oversized partial lines rather than emitting unredacted prefixes', () => {
    const events: string[] = [];
    const output = createOutputRedactor(createSecretRedactor(environment), text =>
      events.push(text)
    );
    output.onOutput('stdout', 'fake-config-key'.repeat(6000));
    output.onOutput('stdout', 'fake-auth-key\nnext safe line\n');
    output.flush();
    expect(events.join('')).toBe('[setup output truncated]\nnext safe line\n');
  });
});

describe('named secret env keys', () => {
  it('redacts a named non-heuristic value from a later environment', () => {
    const secret = 'postgres://user:pass@localhost:5432/app';
    const redact = createSecretRedactor(
      { NODE_ENV: 'production' },
      [{ DATABASE_URL: secret }],
      ['DATABASE_URL']
    );
    expect(redact(`connecting to ${secret} (production)`)).toBe(
      'connecting to [REDACTED] (production)'
    );
  });

  it('redacts split, multiline, and JSON-escaped named values', () => {
    const secret = 'postgres://user:p"a\\ss\nnext-line@db/app';
    const events: string[] = [];
    const output = createOutputRedactor(
      createSecretRedactor({}, [{ CONNECTION_STRING: secret }], ['CONNECTION_STRING']),
      text => events.push(text)
    );
    const line = `CONNECTION_STRING=${secret}\n`;
    for (let index = 0; index < line.length; index += 5) {
      output.onOutput('stdout', line.slice(index, index + 5));
    }
    output.onOutput('stderr', JSON.stringify({ copied: secret }, null, 2));
    output.flush();
    const result = events.join('');
    expect(result).not.toContain('postgres://user');
    expect(result).not.toContain('next-line');
    expect(result).toContain('[REDACTED]');
  });

  it('ignores inherited object property names in the secret key list', () => {
    const redact = createSecretRedactor(
      { NODE_ENV: 'production' },
      [{}],
      ['constructor', 'toString', '__proto__']
    );
    expect(redact('safe output')).toBe('safe output');
  });

  it('leaves a non-heuristic value unchanged when its key is not named', () => {
    const secret = 'postgres://user:pass@localhost:5432/app';
    const redact = createSecretRedactor({ NODE_ENV: 'production' }, [{ DATABASE_URL: secret }]);
    expect(redact(`connecting to ${secret}`)).toBe(`connecting to ${secret}`);
  });
});
