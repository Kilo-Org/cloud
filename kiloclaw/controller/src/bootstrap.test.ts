import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  decryptEnvVars,
  setupDirectories,
  applyFeatureFlags,
  generateHooksToken,
  configureGitHub,
  runOnboardOrDoctor,
  updateToolsMdKiloCliSection,
  updateToolsMd1PasswordSection,
  buildGatewayArgs,
  bootstrap,
} from './bootstrap';
import type { BootstrapDeps } from './bootstrap';

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
  it('generates token when KILOCLAW_GOG_CONFIG_TARBALL is set', () => {
    const env: Record<string, string | undefined> = {
      KILOCLAW_GOG_CONFIG_TARBALL: 'some-base64-tarball',
    };

    generateHooksToken(env);

    expect(env.KILOCLAW_HOOKS_TOKEN).toBeDefined();
    expect(env.KILOCLAW_HOOKS_TOKEN).toHaveLength(64); // 32 bytes = 64 hex chars
  });

  it('does not generate token when tarball is absent', () => {
    const env: Record<string, string | undefined> = {};

    generateHooksToken(env);

    expect(env.KILOCLAW_HOOKS_TOKEN).toBeUndefined();
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

  it('seeds TOOLS.md on fresh install', () => {
    const harness = fakeDeps();
    const env: Record<string, string | undefined> = {
      KILOCODE_API_KEY: 'test-key',
      OPENCLAW_GATEWAY_TOKEN: 'test-token',
      AUTO_APPROVE_DEVICES: 'true',
    };

    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ gateway: { port: 3001, mode: 'local' } })
    );

    runOnboardOrDoctor(env, harness.deps);

    const toolsCopy = harness.copyCalls.find(c => c.dest.endsWith('TOOLS.md'));
    expect(toolsCopy).toBeDefined();
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
  });
});

// ---- updateToolsMdKiloCliSection ----

describe('updateToolsMdKiloCliSection', () => {
  it('adds Kilo CLI section unconditionally', () => {
    const harness = fakeDeps();
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('# TOOLS\n');

    const env: Record<string, string | undefined> = {};

    updateToolsMdKiloCliSection(env, harness.deps);

    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]!.data).toContain('<!-- BEGIN:kilo-cli -->');
    expect(harness.writeCalls[0]!.data).toContain('kilo run --auto');
    expect(harness.writeCalls[0]!.data).toContain('<!-- END:kilo-cli -->');
  });

  it('skips adding when section already present', () => {
    const harness = fakeDeps();
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '# TOOLS\n<!-- BEGIN:kilo-cli -->\nexisting\n<!-- END:kilo-cli -->'
    );

    const env: Record<string, string | undefined> = {};

    updateToolsMdKiloCliSection(env, harness.deps);

    expect(harness.writeCalls).toHaveLength(0);
  });

  it('no-ops when TOOLS.md does not exist', () => {
    const harness = fakeDeps();
    (harness.deps.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const env: Record<string, string | undefined> = {};

    updateToolsMdKiloCliSection(env, harness.deps);

    expect(harness.writeCalls).toHaveLength(0);
  });
});

// ---- updateToolsMd1PasswordSection ----

describe('updateToolsMd1PasswordSection', () => {
  it('adds 1Password section when OP_SERVICE_ACCOUNT_TOKEN is set', () => {
    const harness = fakeDeps();
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('# TOOLS\n');

    const env: Record<string, string | undefined> = {
      OP_SERVICE_ACCOUNT_TOKEN: 'ops_test123',
    };

    updateToolsMd1PasswordSection(env, harness.deps);

    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]!.data).toContain('<!-- BEGIN:1password -->');
    expect(harness.writeCalls[0]!.data).toContain('op vault list');
    expect(harness.writeCalls[0]!.data).toContain('<!-- END:1password -->');
  });

  it('skips adding when section already present', () => {
    const harness = fakeDeps();
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '# TOOLS\n<!-- BEGIN:1password -->\nexisting\n<!-- END:1password -->'
    );

    const env: Record<string, string | undefined> = {
      OP_SERVICE_ACCOUNT_TOKEN: 'ops_test123',
    };

    updateToolsMd1PasswordSection(env, harness.deps);

    expect(harness.writeCalls).toHaveLength(0);
  });

  it('removes stale section when token is absent', () => {
    const harness = fakeDeps();
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '# TOOLS\n<!-- BEGIN:1password -->\nold section\n<!-- END:1password -->\n'
    );

    const env: Record<string, string | undefined> = {};

    updateToolsMd1PasswordSection(env, harness.deps);

    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]!.data).not.toContain('<!-- BEGIN:1password -->');
  });

  it('no-ops when TOOLS.md does not exist', () => {
    const harness = fakeDeps();
    (harness.deps.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const env: Record<string, string | undefined> = {
      OP_SERVICE_ACCOUNT_TOKEN: 'ops_test123',
    };

    updateToolsMd1PasswordSection(env, harness.deps);

    expect(harness.writeCalls).toHaveLength(0);
  });

  it('no-ops when token absent and no stale section exists', () => {
    const harness = fakeDeps();
    (harness.deps.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('# TOOLS\n');

    const env: Record<string, string | undefined> = {};

    updateToolsMd1PasswordSection(env, harness.deps);

    expect(harness.writeCalls).toHaveLength(0);
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

    expect(phases).toEqual(['decrypting', 'directories', 'feature-flags', 'github', 'onboard']);
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
