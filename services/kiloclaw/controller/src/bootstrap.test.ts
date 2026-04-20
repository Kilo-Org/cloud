import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  decryptEnvVars,
  setupDirectories,
  applyFeatureFlags,
  generateHooksToken,
  configureGitHub,
  configureLinear,
  runOnboardOrDoctor,
  formatBotIdentityMarkdown,
  writeBotIdentityFile,
  formatUserProfileMarkdown,
  setUserMdTimezone,
  writeUserProfileTimezoneFile,
  updateToolsMdSection,
  GOG_SECTION_CONFIG,
  KILO_CLI_SECTION_CONFIG,
  OP_SECTION_CONFIG,
  LINEAR_SECTION_CONFIG,
  KILOCLAW_MITIGATIONS_SECTION_CONFIG,
  PLUGIN_INSTALL_SECTION_CONFIG,
  buildGatewayArgs,
  bootstrapCritical,
  bootstrapNonCritical,
  bootstrap,
} from './bootstrap';
import type { BootstrapDeps, ToolsMdSectionConfig } from './bootstrap';

// ---- Encryption helpers (mirrors kiloclaw/src/utils/env-encryption.ts) ----

function generateTestKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

function encryptValue(keyBase64: string, plaintext: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, tag]);
  return 'enc:v1:' + combined.toString('base64');
}

// ---- Fake deps ----

function fakeDeps(): {
  deps: BootstrapDeps;
  mkdirCalls: string[];
  chmodCalls: { path: string; mode: number }[];
  chdirCalls: string[];
  copyCalls: { src: string; dest: string }[];
  execCalls: { cmd: string; args: string[]; input?: string }[];
  writeCalls: { path: string; data: string }[];
  renameCalls: { from: string; to: string }[];
  setConfigExists: (v: boolean) => void;
} {
  const mkdirCalls: string[] = [];
  const chmodCalls: { path: string; mode: number }[] = [];
  const chdirCalls: string[] = [];
  const copyCalls: { src: string; dest: string }[] = [];
  const execCalls: { cmd: string; args: string[]; input?: string }[] = [];
  const writeCalls: { path: string; data: string }[] = [];
  const renameCalls: { from: string; to: string }[] = [];
  let configExists = false;

  return {
    deps: {
      mkdirSync: vi.fn((dir: string) => {
        mkdirCalls.push(dir);
      }),
      chmodSync: vi.fn((p: string, mode: number) => {
        chmodCalls.push({ path: p, mode });
      }),
      chdir: vi.fn((dir: string) => {
        chdirCalls.push(dir);
      }),
      existsSync: vi.fn((p: string) => {
        if (p.endsWith('openclaw.json')) return configExists;
        if (p.endsWith('TOOLS.md')) return true;
        return false;
      }),
      copyFileSync: vi.fn((src: string, dest: string) => {
        copyCalls.push({ src, dest });
      }),
      writeFileSync: vi.fn((p: string, data: string) => {
        writeCalls.push({ path: p, data });
      }),
      readFileSync: vi.fn((_p: string) => {
        return '{}';
      }),
      renameSync: vi.fn((from: string, to: string) => {
        renameCalls.push({ from, to });
      }),
      unlinkSync: vi.fn(),
      readdirSync: vi.fn(() => [] as string[]),
      execFileSync: vi.fn((cmd: string, args: string[], opts?: { input?: string }) => {
        execCalls.push({ cmd, args, input: opts?.input });
        return '';
      }),
    },
    mkdirCalls,
    chmodCalls,
    chdirCalls,
    copyCalls,
    execCalls,
    writeCalls,
    renameCalls,
    setConfigExists(v: boolean) {
      configExists = v;
    },
  };
}

// ---- decryptEnvVars ----

describe('decryptEnvVars', () => {
  it('decrypts encrypted vars and strips KILOCLAW_ENC_ prefix', () => {
    const key = generateTestKey();
    const env: Record<string, string | undefined> = {
      KILOCLAW_ENV_KEY: key,
      KILOCLAW_ENC_KILOCODE_API_KEY: encryptValue(key, 'my-api-key'),
      KILOCLAW_ENC_OPENCLAW_GATEWAY_TOKEN: encryptValue(key, 'my-gw-token'),
    };

    decryptEnvVars(env);

    expect(env.KILOCODE_API_KEY).toBe('my-api-key');
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe('my-gw-token');
    // Encrypted vars and key cleaned up
    expect(env.KILOCLAW_ENC_KILOCODE_API_KEY).toBeUndefined();
    expect(env.KILOCLAW_ENC_OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.KILOCLAW_ENV_KEY).toBeUndefined();
  });

  it('throws if KILOCLAW_ENC_* vars exist without KILOCLAW_ENV_KEY', () => {
    const env: Record<string, string | undefined> = {
      KILOCLAW_ENC_FOO: 'enc:v1:bogus',
    };

    expect(() => decryptEnvVars(env)).toThrow('KILOCLAW_ENV_KEY is not set');
  });

  it('no-ops when no encrypted vars exist', () => {
    const env: Record<string, string | undefined> = {
      KILOCODE_API_KEY: 'plaintext-key',
      OPENCLAW_GATEWAY_TOKEN: 'plaintext-token',
    };

    decryptEnvVars(env);

    expect(env.KILOCODE_API_KEY).toBe('plaintext-key');
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe('plaintext-token');
  });

  it('cleans up key even when no encrypted vars exist', () => {
    const env: Record<string, string | undefined> = {
      KILOCLAW_ENV_KEY: 'some-key',
      KILOCODE_API_KEY: 'plaintext-key',
      OPENCLAW_GATEWAY_TOKEN: 'plaintext-token',
    };

    decryptEnvVars(env);

    expect(env.KILOCLAW_ENV_KEY).toBeUndefined();
  });

  it('throws when KILOCODE_API_KEY missing without encryption', () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_GATEWAY_TOKEN: 'token',
    };

    expect(() => decryptEnvVars(env)).toThrow('KILOCODE_API_KEY is required');
  });

  it('throws when OPENCLAW_GATEWAY_TOKEN missing without encryption', () => {
    const env: Record<string, string | undefined> = {
      KILOCODE_API_KEY: 'key',
    };

    expect(() => decryptEnvVars(env)).toThrow('OPENCLAW_GATEWAY_TOKEN is required');
  });

  it('throws on missing KILOCODE_API_KEY after decryption', () => {
    const key = generateTestKey();
    const env: Record<string, string | undefined> = {
      KILOCLAW_ENV_KEY: key,
      KILOCLAW_ENC_OPENCLAW_GATEWAY_TOKEN: encryptValue(key, 'token'),
    };

    expect(() => decryptEnvVars(env)).toThrow('KILOCODE_API_KEY missing after decryption');
  });

  it('throws on missing OPENCLAW_GATEWAY_TOKEN after decryption', () => {
    const key = generateTestKey();
    const env: Record<string, string | undefined> = {
      KILOCLAW_ENV_KEY: key,
      KILOCLAW_ENC_KILOCODE_API_KEY: encryptValue(key, 'api-key'),
    };

    expect(() => decryptEnvVars(env)).toThrow('OPENCLAW_GATEWAY_TOKEN missing after decryption');
  });

  it('throws on invalid value prefix', () => {
    const key = generateTestKey();
    const env: Record<string, string | undefined> = {
      KILOCLAW_ENV_KEY: key,
      KILOCLAW_ENC_FOO: 'not-encrypted',
    };

    expect(() => decryptEnvVars(env)).toThrow('does not start with enc:v1:');
  });

  it('throws on invalid env var name after stripping prefix', () => {
    const key = generateTestKey();
    const env: Record<string, string | undefined> = {
      KILOCLAW_ENV_KEY: key,
      ['KILOCLAW_ENC_123-invalid']: encryptValue(key, 'value'),
    };

    expect(() => decryptEnvVars(env)).toThrow('Invalid env var name');
  });

  it('throws on tampered ciphertext', () => {
    const key = generateTestKey();
    // Create a valid encrypted value, then corrupt it
    const valid = encryptValue(key, 'secret');
    const prefix = 'enc:v1:';
    const data = Buffer.from(valid.slice(prefix.length), 'base64');
    // Flip a byte in the ciphertext portion
    data[15] ^= 0xff;
    const corrupted = prefix + data.toString('base64');

    const env: Record<string, string | undefined> = {
      KILOCLAW_ENV_KEY: key,
      KILOCLAW_ENC_FOO: corrupted,
    };

    expect(() => decryptEnvVars(env)).toThrow();
  });

  it('handles values with special characters', () => {
    const key = generateTestKey();
    const specialValue = 'it\'s a "test" with\nnewlines & symbols!';
    const env: Record<string, string | undefined> = {
      KILOCLAW_ENV_KEY: key,
      KILOCLAW_ENC_KILOCODE_API_KEY: encryptValue(key, specialValue),
      KILOCLAW_ENC_OPENCLAW_GATEWAY_TOKEN: encryptValue(key, 'token'),
    };

    decryptEnvVars(env);

    expect(env.KILOCODE_API_KEY).toBe(specialValue);
  });
});

// ---- setupDirectories ----

describe('setupDirectories', () => {
  it('creates required directories', () => {
    const { deps, mkdirCalls, chdirCalls } = fakeDeps();
    const env: Record<string, string | undefined> = {};

    setupDirectories(env, deps);

    expect(mkdirCalls).toContain('/root/.openclaw');
    expect(mkdirCalls).toContain('/root/clawd');
    expect(mkdirCalls).toContain('/var/tmp/openclaw-compile-cache');
    expect(chdirCalls).toEqual(['/root/clawd']);
  });

  it('sets chmod 700 on config dir', () => {
    const { deps, chmodCalls } = fakeDeps();
    const env: Record<string, string | undefined> = {};

    setupDirectories(env, deps);

    expect(chmodCalls).toContainEqual({ path: '/root/.openclaw', mode: 0o700 });
  });

  it('sets required env vars', () => {
    const { deps } = fakeDeps();
    const env: Record<string, string | undefined> = {};

    setupDirectories(env, deps);

    expect(env.OPENCLAW_NO_RESPAWN).toBe('1');
    expect(env.NODE_COMPILE_CACHE).toBe('/var/tmp/openclaw-compile-cache');
    expect(env.INVOCATION_ID).toBe('1');
    expect(env.GOG_KEYRING_PASSWORD).toBe('kiloclaw');
  });

  it('derives KILO_API_URL from KILOCODE_API_BASE_URL origin', () => {
    const { deps } = fakeDeps();
    const env: Record<string, string | undefined> = {
      KILOCODE_API_BASE_URL: 'https://api.example.com/v1',
    };

    setupDirectories(env, deps);

    expect(env.KILO_API_URL).toBe('https://api.example.com');
  });

  it('does not set KILO_API_URL when KILOCODE_API_BASE_URL is absent', () => {
    const { deps } = fakeDeps();
    const env: Record<string, string | undefined> = {};

    setupDirectories(env, deps);

    expect(env.KILO_API_URL).toBeUndefined();
  });
});

// ---- applyFeatureFlags ----

describe('applyFeatureFlags', () => {
  it('sets up npm global prefix when flag is true', () => {
    const { deps, mkdirCalls } = fakeDeps();
    const env: Record<string, string | undefined> = {
      KILOCLAW_NPM_GLOBAL_PREFIX: 'true',
      PATH: '/usr/bin',
    };

    applyFeatureFlags(env, deps);

    expect(mkdirCalls).toContain('/root/.npm-global/bin');
    expect(env.NPM_CONFIG_PREFIX).toBe('/root/.npm-global');
    expect(env.PATH).toContain('/root/.npm-global/bin');
  });

  it('does not set npm prefix when flag is absent', () => {
    const { deps } = fakeDeps();
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' };

    applyFeatureFlags(env, deps);

    expect(env.NPM_CONFIG_PREFIX).toBeUndefined();
  });

  it('sets up pip global prefix when flag is true', () => {
    const { deps, mkdirCalls } = fakeDeps();
    const env: Record<string, string | undefined> = {
      KILOCLAW_PIP_GLOBAL_PREFIX: 'true',
      PATH: '/usr/bin',
    };

    applyFeatureFlags(env, deps);

    expect(mkdirCalls).toContain('/root/.pip-global/bin');
    expect(env.PYTHONUSERBASE).toBe('/root/.pip-global');
    expect(env.PATH).toContain('/root/.pip-global/bin');
  });

  it('sets up uv global prefix when flag is true', () => {
    const { deps, mkdirCalls } = fakeDeps();
    const env: Record<string, string | undefined> = {
      KILOCLAW_UV_GLOBAL_PREFIX: 'true',
      PATH: '/usr/bin',
    };

    applyFeatureFlags(env, deps);

    expect(mkdirCalls).toContain('/root/.uv/tools');
    expect(mkdirCalls).toContain('/root/.uv/bin');
    expect(mkdirCalls).toContain('/root/.uv/cache');
    expect(env.UV_TOOL_DIR).toBe('/root/.uv/tools');
    expect(env.UV_TOOL_BIN_DIR).toBe('/root/.uv/bin');
    expect(env.UV_CACHE_DIR).toBe('/root/.uv/cache');
    expect(env.PATH).toContain('/root/.uv/bin');
  });

  it('aliases KILO_API_KEY when kilo-cli flag is true', () => {
    const { deps } = fakeDeps();
    const env: Record<string, string | undefined> = {
      KILOCLAW_KILO_CLI: 'true',
      KILOCODE_API_KEY: 'test-key',
    };

    applyFeatureFlags(env, deps);

    expect(env.KILO_API_KEY).toBe('test-key');
  });

  it('does not alias KILO_API_KEY when KILOCODE_API_KEY is absent', () => {
    const { deps } = fakeDeps();
    const env: Record<string, string | undefined> = {
      KILOCLAW_KILO_CLI: 'true',
    };

    applyFeatureFlags(env, deps);

    expect(env.KILO_API_KEY).toBeUndefined();
  });

  it('logs warning when mkdir fails for npm prefix', () => {
    const harness = fakeDeps();
    (harness.deps.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('permission denied');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env: Record<string, string | undefined> = {
      KILOCLAW_NPM_GLOBAL_PREFIX: 'true',
    };

    applyFeatureFlags(env, harness.deps);

    expect(env.NPM_CONFIG_PREFIX).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to create npm-global'));
    warnSpy.mockRestore();
  });
});

// ---- generateHooksToken ----

describe('generateHooksToken', () => {
  it('generates token for every boot', () => {
    const env: Record<string, string | undefined> = {};

    generateHooksToken(env);

    expect(env.KILOCLAW_HOOKS_TOKEN).toBeDefined();
    expect(env.KILOCLAW_HOOKS_TOKEN).toHaveLength(64); // 32 bytes = 64 hex chars
  });

  it('replaces any existing token with a fresh value', () => {
    const env: Record<string, string | undefined> = { KILOCLAW_HOOKS_TOKEN: 'old-token' };

    generateHooksToken(env);

    expect(env.KILOCLAW_HOOKS_TOKEN).not.toBe('old-token');
    expect(env.KILOCLAW_HOOKS_TOKEN).toHaveLength(64);
  });
});

// ---- configureGitHub ----

describe('configureGitHub', () => {
  it('runs gh auth login when GITHUB_TOKEN is set', () => {
    const { deps, execCalls } = fakeDeps();
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: 'ghp_test123',
    };

    configureGitHub(env, deps);

    expect(execCalls[0]).toEqual({
      cmd: 'gh',
      args: ['auth', 'login', '--with-token'],
      input: 'ghp_test123',
    });
    expect(execCalls[1]).toEqual({
      cmd: 'gh',
      args: ['auth', 'setup-git'],
      input: undefined,
    });
  });

  it('sets git user.name and user.email when provided', () => {
    const { deps, execCalls } = fakeDeps();
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: 'ghp_test123',
      GITHUB_USERNAME: 'testuser',
      GITHUB_EMAIL: 'test@example.com',
    };

    configureGitHub(env, deps);

    expect(execCalls).toContainEqual({
      cmd: 'git',
      args: ['config', '--global', 'user.name', 'testuser'],
      input: undefined,
    });
    expect(execCalls).toContainEqual({
      cmd: 'git',
      args: ['config', '--global', 'user.email', 'test@example.com'],
      input: undefined,
    });
  });

  it('does not set git user config when username/email absent', () => {
    const { deps, execCalls } = fakeDeps();
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: 'ghp_test123',
    };

    configureGitHub(env, deps);

    const gitConfigCalls = execCalls.filter(c => c.cmd === 'git' && c.args.includes('user.name'));
    expect(gitConfigCalls).toHaveLength(0);
  });

  it('runs cleanup when no GITHUB_TOKEN', () => {
    const { deps, execCalls } = fakeDeps();
    const env: Record<string, string | undefined> = {};

    configureGitHub(env, deps);

    expect(execCalls[0]).toEqual({
      cmd: 'gh',
      args: ['auth', 'logout', '--hostname', 'github.com'],
      input: undefined,
    });
  });

  it('does not throw when gh auth login fails', () => {
    const harness = fakeDeps();
    let callCount = 0;
    (harness.deps.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('gh not found');
      return '';
    });
    const env: Record<string, string | undefined> = {
      GITHUB_TOKEN: 'ghp_test123',
    };

    expect(() => configureGitHub(env, harness.deps)).not.toThrow();
  });
});

// ---- configureLinear ----

describe('configureLinear', () => {
  it('logs configured when LINEAR_API_KEY is set', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env: Record<string, string | undefined> = {
      LINEAR_API_KEY: 'lin_api_test123',
    };

    configureLinear(env);

    expect(env.LINEAR_API_KEY).toBe('lin_api_test123');
    expect(logSpy).toHaveBeenCalledWith('Linear MCP configured via LINEAR_API_KEY');
    logSpy.mockRestore();
  });

  it('cleans up empty LINEAR_API_KEY and logs not configured', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env: Record<string, string | undefined> = {
      LINEAR_API_KEY: '',
    };

    configureLinear(env);

    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('Linear: not configured');
    logSpy.mockRestore();
  });

  it('logs not configured when LINEAR_API_KEY is absent', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env: Record<string, string | undefined> = {};

    configureLinear(env);

    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('Linear: not configured');
    logSpy.mockRestore();
  });
});

// ---- bot identity file ----

describe('formatBotIdentityMarkdown', () => {
  it('renders the bot identity markdown with defaults', () => {
    const result = formatBotIdentityMarkdown({});

    expect(result).toContain('# IDENTITY');
    expect(result).toContain('- Name: KiloClaw');
    expect(result).toContain('- Nature: AI executive assistant');
  });
});

describe('writeBotIdentityFile', () => {
  it('writes workspace/IDENTITY.md and removes legacy files when present', () => {
    const harness = fakeDeps();
    (harness.deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p === '/root/.openclaw/workspace/BOOTSTRAP.md'
    );

    writeBotIdentityFile(
      { KILOCLAW_BOT_NAME: 'Milo', KILOCLAW_BOT_NATURE: 'Operator' },
      harness.deps
    );

    expect(
      harness.renameCalls.some(call => call.to === '/root/.openclaw/workspace/IDENTITY.md')
    ).toBe(true);
    expect((harness.deps.unlinkSync as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['/root/.openclaw/workspace/BOOTSTRAP.md'],
    ]);
  });
});

// ---- user profile file ----

describe('formatUserProfileMarkdown', () => {
  it('renders the user profile markdown with timezone', () => {
    const result = formatUserProfileMarkdown('Europe/Amsterdam');

    expect(result).toContain('# USER.md - About Your Human');
    expect(result).toContain('- Timezone: Europe/Amsterdam');
  });
});

describe('setUserMdTimezone', () => {
  it('updates a plain timezone field', () => {
    const result = setUserMdTimezone('# USER\n- Timezone:\n- Notes:\n', 'Europe/Amsterdam');

    expect(result).toContain('- Timezone: Europe/Amsterdam');
    expect(result).toContain('- Notes:');
  });

  it('updates a bold timezone field', () => {
    const result = setUserMdTimezone(
      '# USER\n- **Timezone:** [America/New_York, Europe/London, etc.]\n',
      'Europe/Amsterdam'
    );

    expect(result).toContain('- **Timezone:** Europe/Amsterdam');
  });

  it('appends a timezone field when none exists', () => {
    const result = setUserMdTimezone('# USER\n- Name:\n', 'Europe/Amsterdam');

    expect(result).toContain('- Name:');
    expect(result).toContain('- Timezone: Europe/Amsterdam');
  });
});

describe('writeUserProfileTimezoneFile', () => {
  it('creates workspace/USER.md when timezone is configured', () => {
    const harness = fakeDeps();

    writeUserProfileTimezoneFile({ KILOCLAW_USER_TIMEZONE: 'Europe/Amsterdam' }, harness.deps);

    const userWrite = harness.writeCalls.find(call => call.path.includes('USER.md'));
    expect(userWrite?.data).toContain('- Timezone: Europe/Amsterdam');
    expect(harness.renameCalls.some(call => call.to === '/root/.openclaw/workspace/USER.md')).toBe(
      true
    );
  });

  it('updates existing workspace/USER.md when timezone is configured', () => {
    const harness = fakeDeps();
    (harness.deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p === '/root/.openclaw/workspace/USER.md'
    );
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '# USER\n- Timezone:\n- Notes:\n'
    );

    writeUserProfileTimezoneFile({ KILOCLAW_USER_TIMEZONE: 'Europe/Amsterdam' }, harness.deps);

    const userWrite = harness.writeCalls.find(call => call.path.includes('USER.md'));
    expect(userWrite?.data).toContain('- Timezone: Europe/Amsterdam');
    expect(userWrite?.data).toContain('- Notes:');
  });

  it('does not write workspace/USER.md when timezone is unset', () => {
    const harness = fakeDeps();

    writeUserProfileTimezoneFile({}, harness.deps);

    expect(harness.writeCalls.some(call => call.path.includes('USER.md'))).toBe(false);
  });
});

// ---- runOnboardOrDoctor ----

describe('runOnboardOrDoctor', () => {
  it('runs writeBaseConfig when no config exists', () => {
    const harness = fakeDeps();
    // Config does not exist (default)
    const env: Record<string, string | undefined> = {
      KILOCODE_API_KEY: 'test-key',
      OPENCLAW_GATEWAY_TOKEN: 'test-token',
      AUTO_APPROVE_DEVICES: 'true',
    };

    // writeBaseConfig calls execFileSync (openclaw onboard) and reads/writes files.
    // For this unit test, we verify the env var side effects.
    // The actual writeBaseConfig logic is tested in config-writer.test.ts.
    // We need to make the deps handle the writeBaseConfig internal calls.
    let onboardCalled = false;
    (harness.deps.execFileSync as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      if (cmd === 'openclaw') onboardCalled = true;
      return '';
    });

    // writeBaseConfig reads from the temp file after onboard writes to it
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({
        gateway: { port: 3001, mode: 'local' },
      })
    );

    runOnboardOrDoctor(env, harness.deps);

    expect(env.KILOCLAW_FRESH_INSTALL).toBe('true');
    expect(onboardCalled).toBe(true);
  });

  it('seeds TOOLS.md and USER.md timezone on fresh install', () => {
    const harness = fakeDeps();
    const env: Record<string, string | undefined> = {
      KILOCODE_API_KEY: 'test-key',
      OPENCLAW_GATEWAY_TOKEN: 'test-token',
      AUTO_APPROVE_DEVICES: 'true',
      KILOCLAW_USER_TIMEZONE: 'Europe/Amsterdam',
    };

    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ gateway: { port: 3001, mode: 'local' } })
    );

    runOnboardOrDoctor(env, harness.deps);

    const toolsCopy = harness.copyCalls.find(c => c.dest.endsWith('TOOLS.md'));
    expect(toolsCopy).toBeDefined();
    expect(harness.renameCalls.some(call => call.to.endsWith('/workspace/IDENTITY.md'))).toBe(true);
    expect(harness.renameCalls.some(call => call.to.endsWith('/workspace/USER.md'))).toBe(true);
    expect(
      harness.writeCalls.some(call => call.data.includes('- Timezone: Europe/Amsterdam'))
    ).toBe(true);
  });

  it('runs doctor when config exists', () => {
    const harness = fakeDeps();
    // Make config exist
    (harness.deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p.endsWith('openclaw.json')) return true;
      return false;
    });
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ gateway: { port: 3001 } })
    );

    const env: Record<string, string | undefined> = {
      KILOCODE_API_KEY: 'test-key',
      OPENCLAW_GATEWAY_TOKEN: 'test-token',
      AUTO_APPROVE_DEVICES: 'true',
    };

    runOnboardOrDoctor(env, harness.deps);

    const doctorCall = harness.execCalls.find(
      c => c.cmd === 'openclaw' && c.args.includes('doctor')
    );
    expect(doctorCall).toBeDefined();
    expect(doctorCall?.args).toContain('--fix');
    expect(doctorCall?.args).toContain('--non-interactive');
    expect(env.KILOCLAW_FRESH_INSTALL).toBe('false');
    expect(harness.renameCalls.some(call => call.to.endsWith('/workspace/IDENTITY.md'))).toBe(true);
  });
});

// ---- updateToolsMdSection ----

describe('updateToolsMdSection', () => {
  const testConfig: ToolsMdSectionConfig = {
    name: 'Test',
    beginMarker: '<!-- BEGIN:test -->',
    endMarker: '<!-- END:test -->',
    section: '\n<!-- BEGIN:test -->\n## Test Section\n<!-- END:test -->',
  };

  it('appends section when enabled and not present', () => {
    const harness = fakeDeps();
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('# TOOLS\n');

    updateToolsMdSection(true, testConfig, harness.deps);

    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]!.data).toContain('<!-- BEGIN:test -->');
    expect(harness.writeCalls[0]!.data).toContain('## Test Section');
    expect(harness.writeCalls[0]!.data).toContain('<!-- END:test -->');
  });

  it('skips adding when section already present', () => {
    const harness = fakeDeps();
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '# TOOLS\n<!-- BEGIN:test -->\nexisting\n<!-- END:test -->'
    );

    updateToolsMdSection(true, testConfig, harness.deps);

    expect(harness.writeCalls).toHaveLength(0);
  });

  it('removes stale section when disabled', () => {
    const harness = fakeDeps();
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '# TOOLS\n<!-- BEGIN:test -->\nold section\n<!-- END:test -->\n'
    );

    updateToolsMdSection(false, testConfig, harness.deps);

    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]!.data).not.toContain('<!-- BEGIN:test -->');
  });

  it('no-ops when disabled and no stale section exists', () => {
    const harness = fakeDeps();
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('# TOOLS\n');

    updateToolsMdSection(false, testConfig, harness.deps);

    expect(harness.writeCalls).toHaveLength(0);
  });

  it('no-ops when TOOLS.md does not exist', () => {
    const harness = fakeDeps();
    (harness.deps.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    updateToolsMdSection(true, testConfig, harness.deps);

    expect(harness.writeCalls).toHaveLength(0);
  });

  it('warns when BEGIN marker found but END marker missing', () => {
    const harness = fakeDeps();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const brokenConfig: ToolsMdSectionConfig = {
      ...testConfig,
      endMarker: '<!-- END:nonexistent -->',
    };
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '# TOOLS\n<!-- BEGIN:test -->\norphaned section\n'
    );

    updateToolsMdSection(false, brokenConfig, harness.deps);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('BEGIN marker found but END marker missing')
    );
    expect(harness.writeCalls).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

// ---- section config correctness ----

describe('TOOLS.md section configs', () => {
  const configs: ToolsMdSectionConfig[] = [
    GOG_SECTION_CONFIG,
    KILO_CLI_SECTION_CONFIG,
    OP_SECTION_CONFIG,
    LINEAR_SECTION_CONFIG,
    KILOCLAW_MITIGATIONS_SECTION_CONFIG,
    PLUGIN_INSTALL_SECTION_CONFIG,
  ];

  for (const config of configs) {
    it(`${config.name}: section contains both markers`, () => {
      expect(config.section).toContain(config.beginMarker);
      expect(config.section).toContain(config.endMarker);
    });
  }

  // Smoke test on the KiloClaw-specific sections we just added — pin the
  // key directives so a drive-by edit that strips the substance (but keeps
  // the markers) fails loudly.
  it('KiloClaw Mitigations: names all additional mitigated checkIds', () => {
    const section = KILOCLAW_MITIGATIONS_SECTION_CONFIG.section;
    expect(section).toContain('gateway.trusted_proxies_missing');
    expect(section).toContain('config.insecure_or_dangerous_flags');
    expect(section).toContain('plugins.tools_reachable_permissive_policy');
    expect(section).toContain('hooks.default_session_key_unset');
    expect(section).toContain('hooks.allowed_agent_ids_unrestricted');
    expect(section).toContain('fs.config.perms_world_readable');
    // Does NOT redundantly list gateway.control_ui.insecure_auth as its own
    // bullet — that one is already documented in the base TOOLS.md's
    // "Security Check Context" section. In-body references to it are fine
    // (the config.insecure_or_dangerous_flags explanation points back at
    // it), but a duplicate top-level bullet would mean the agent sees it
    // twice in workspace context.
    expect(section).not.toContain('- **`gateway.control_ui.insecure_auth`**');
  });

  it('Plugin Install: references the CLI command and plugins.allow field', () => {
    const section = PLUGIN_INSTALL_SECTION_CONFIG.section;
    expect(section).toContain('openclaw plugins install');
    expect(section).toContain('plugins.allow');
    expect(section).toContain('ALWAYS');
    // Safety: must explicitly tell the agent NOT to create plugins.allow
    // from scratch on permissive instances. Creating a single-element
    // allowlist would silently block bundled channel plugins (Telegram,
    // Discord, Slack, Stream Chat, etc.) that are loaded under permissive
    // mode without being enumerated. See the kilo-code-bot review on
    // PR #2597 for the production incident this guards against.
    expect(section).toContain('DO NOT create');
    expect(section).toContain('permissive mode');
  });
});

// ---- buildGatewayArgs ----

describe('buildGatewayArgs', () => {
  it('includes --token when OPENCLAW_GATEWAY_TOKEN is set', () => {
    const args = buildGatewayArgs({ OPENCLAW_GATEWAY_TOKEN: 'tok-123' });

    expect(args).toContain('--token');
    expect(args[args.indexOf('--token') + 1]).toBe('tok-123');
    expect(args).toContain('--port');
    expect(args).toContain('--verbose');
    expect(args).toContain('--allow-unconfigured');
    expect(args).toContain('--bind');
  });

  it('excludes --token when OPENCLAW_GATEWAY_TOKEN is not set', () => {
    const args = buildGatewayArgs({});

    expect(args).not.toContain('--token');
    expect(args).toContain('--port');
  });

  it('builds the expected gateway args array', () => {
    const args = buildGatewayArgs({ OPENCLAW_GATEWAY_TOKEN: 'tok-123' });

    expect(args).toEqual([
      '--port',
      '3001',
      '--verbose',
      '--allow-unconfigured',
      '--bind',
      'loopback',
      '--token',
      'tok-123',
    ]);
  });
});

// ---- bootstrapCritical ----

describe('bootstrapCritical', () => {
  it('sets critical phases and gateway args', async () => {
    const key = generateTestKey();
    const phases: string[] = [];
    const harness = fakeDeps();
    const env: Record<string, string | undefined> = {
      KILOCLAW_ENV_KEY: key,
      KILOCLAW_ENC_KILOCODE_API_KEY: encryptValue(key, 'api-key'),
      KILOCLAW_ENC_OPENCLAW_GATEWAY_TOKEN: encryptValue(key, 'gw-token'),
      AUTO_APPROVE_DEVICES: 'true',
    };

    await bootstrapCritical(env, phase => phases.push(phase), harness.deps);

    expect(phases).toEqual(['decrypting', 'directories', 'feature-flags']);
    expect(JSON.parse(env.KILOCLAW_GATEWAY_ARGS ?? '[]')).toContain('gw-token');
  });

  it('throws before later steps when decryption fails', async () => {
    const phases: string[] = [];
    const harness = fakeDeps();

    await expect(
      bootstrapCritical(
        { KILOCLAW_ENC_FOO: 'enc:v1:bogus' },
        phase => phases.push(phase),
        harness.deps
      )
    ).rejects.toThrow('KILOCLAW_ENV_KEY is not set');

    expect(phases).toEqual(['decrypting']);
    expect(harness.mkdirCalls).toHaveLength(0);
  });
});

// ---- bootstrapNonCritical ----

describe('bootstrapNonCritical', () => {
  it('treats github CLI failures as best-effort and continues', async () => {
    const harness = fakeDeps();
    const phases: string[] = [];
    (harness.deps.execFileSync as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      if (cmd === 'gh') {
        throw new Error('gh auth failed');
      }
      return '';
    });

    const result = await bootstrapNonCritical(
      {
        GITHUB_TOKEN: 'gh-token',
        KILOCODE_API_KEY: 'api-key',
        OPENCLAW_GATEWAY_TOKEN: 'gw-token',
        AUTO_APPROVE_DEVICES: 'true',
      },
      phase => phases.push(phase),
      harness.deps
    );

    expect(result).toEqual({ ok: true });
    expect(phases).toEqual(['github', 'linear', 'onboard', 'tools-md', 'mcporter']);
  });

  it('returns tools-md failure and stops before mcporter', async () => {
    const harness = fakeDeps();
    const phases: string[] = [];
    (harness.deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p.endsWith('openclaw.json')) return false;
      if (p.endsWith('workspace/TOOLS.md')) return true;
      return false;
    });
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p.endsWith('workspace/TOOLS.md')) {
        throw new Error('tools read failed');
      }
      return '';
    });

    const result = await bootstrapNonCritical(
      {
        KILOCODE_API_KEY: 'api-key',
        OPENCLAW_GATEWAY_TOKEN: 'gw-token',
        AUTO_APPROVE_DEVICES: 'true',
      },
      phase => phases.push(phase),
      harness.deps
    );

    expect(result).toEqual({ ok: false, phase: 'tools-md', error: 'tools read failed' });
    expect(phases).toEqual(['github', 'linear', 'onboard', 'tools-md']);
  });

  it('returns ok when doctor/onboard succeeds', async () => {
    const harness = fakeDeps();
    const phases: string[] = [];
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ gateway: { port: 3001, mode: 'local' } })
    );

    const result = await bootstrapNonCritical(
      {
        KILOCODE_API_KEY: 'api-key',
        OPENCLAW_GATEWAY_TOKEN: 'gw-token',
        AUTO_APPROVE_DEVICES: 'true',
      },
      phase => phases.push(phase),
      harness.deps
    );

    expect(result).toEqual({ ok: true });
    expect(phases).toEqual(['github', 'linear', 'onboard', 'tools-md', 'mcporter']);
  });

  it('returns a doctor failure instead of throwing', async () => {
    const harness = fakeDeps();
    const phases: string[] = [];
    (harness.deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p.endsWith('openclaw.json')) return true;
      return false;
    });
    (harness.deps.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      (cmd: string, args: string[]) => {
        if (cmd === 'openclaw' && args.includes('doctor')) {
          throw new Error('doctor exited 1');
        }
        return '';
      }
    );

    const result = await bootstrapNonCritical(
      {
        KILOCODE_API_KEY: 'api-key',
        OPENCLAW_GATEWAY_TOKEN: 'gw-token',
        AUTO_APPROVE_DEVICES: 'true',
      },
      phase => phases.push(phase),
      harness.deps
    );

    expect(result).toEqual({ ok: false, phase: 'doctor', error: 'doctor exited 1' });
    expect(phases).toEqual(['github', 'linear', 'doctor']);
  });
});

// ---- bootstrap orchestrator ----

describe('bootstrap', () => {
  it('calls setPhase with correct phase names in order', async () => {
    const key = generateTestKey();
    const phases: string[] = [];
    const harness = fakeDeps();

    // Config does not exist — will take the onboard path
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ gateway: { port: 3001, mode: 'local' } })
    );

    const env: Record<string, string | undefined> = {
      KILOCLAW_ENV_KEY: key,
      KILOCLAW_ENC_KILOCODE_API_KEY: encryptValue(key, 'api-key'),
      KILOCLAW_ENC_OPENCLAW_GATEWAY_TOKEN: encryptValue(key, 'gw-token'),
      AUTO_APPROVE_DEVICES: 'true',
    };

    await bootstrap(env, phase => phases.push(phase), harness.deps);

    expect(phases).toEqual([
      'decrypting',
      'directories',
      'feature-flags',
      'github',
      'linear',
      'onboard',
      'tools-md',
      'mcporter',
    ]);
  });

  it('reports doctor phase when config exists', async () => {
    const phases: string[] = [];
    const harness = fakeDeps();

    (harness.deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p.endsWith('openclaw.json')) return true;
      return false;
    });
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ gateway: { port: 3001 } })
    );

    const env: Record<string, string | undefined> = {
      KILOCODE_API_KEY: 'api-key',
      OPENCLAW_GATEWAY_TOKEN: 'gw-token',
      AUTO_APPROVE_DEVICES: 'true',
    };

    await bootstrap(env, phase => phases.push(phase), harness.deps);

    expect(phases).toContain('doctor');
    expect(phases).not.toContain('onboard');
  });

  it('sets KILOCLAW_GATEWAY_ARGS after all steps complete', async () => {
    const harness = fakeDeps();
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ gateway: { port: 3001, mode: 'local' } })
    );

    const env: Record<string, string | undefined> = {
      KILOCODE_API_KEY: 'api-key',
      OPENCLAW_GATEWAY_TOKEN: 'gw-token',
      AUTO_APPROVE_DEVICES: 'true',
    };

    await bootstrap(env, () => {}, harness.deps);

    const args = JSON.parse(env.KILOCLAW_GATEWAY_ARGS ?? '[]') as string[];
    expect(args).toContain('--token');
    expect(args).toContain('gw-token');
  });

  it('does not call subsequent steps when decryption fails', async () => {
    const phases: string[] = [];
    const harness = fakeDeps();

    const env: Record<string, string | undefined> = {
      KILOCLAW_ENC_FOO: 'enc:v1:bogus',
      // No KILOCLAW_ENV_KEY — will fail
    };

    await expect(bootstrap(env, phase => phases.push(phase), harness.deps)).rejects.toThrow(
      'KILOCLAW_ENV_KEY is not set'
    );

    expect(phases).toEqual(['decrypting']);
    expect(harness.mkdirCalls).toHaveLength(0);
  });
});
