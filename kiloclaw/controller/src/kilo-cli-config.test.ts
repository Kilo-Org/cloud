import { describe, it, expect, vi } from 'vitest';
import { writeKiloCliConfig, toKiloModelId, type KiloCliConfigDeps } from './kilo-cli-config';

function fakeDeps(existingConfig?: string) {
  const written: { path: string; data: string; mode: number }[] = [];
  const dirs: string[] = [];

  const deps: KiloCliConfigDeps = {
    mkdirSync: vi.fn((dir: string, _opts: { recursive: boolean }) => {
      dirs.push(dir);
    }),
    writeFileSync: vi.fn((filePath: string, data: string, opts: { mode: number }) => {
      written.push({ path: filePath, data, mode: opts.mode });
    }),
    readFileSync: vi.fn((_path: string) => {
      if (existingConfig !== undefined) return existingConfig;
      throw new Error('ENOENT');
    }),
    existsSync: vi.fn((filePath: string) => {
      if (filePath.endsWith('opencode.json')) return existingConfig !== undefined;
      return false;
    }),
  };

  return { deps, written, dirs };
}

function baseEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    KILOCLAW_KILO_CLI: 'true',
    KILOCODE_API_KEY: 'test-jwt-token',
    KILOCLAW_FRESH_INSTALL: 'true',
    ...overrides,
  };
}

describe('toKiloModelId', () => {
  it('replaces kilocode/ prefix with kilo/', () => {
    expect(toKiloModelId('kilocode/anthropic/claude-opus-4.6')).toBe('kilo/anthropic/claude-opus-4.6');
    expect(toKiloModelId('kilocode/openai/gpt-5')).toBe('kilo/openai/gpt-5');
  });

  it('passes through values without kilocode/ prefix', () => {
    expect(toKiloModelId('kilo/anthropic/claude-opus-4.6')).toBe('kilo/anthropic/claude-opus-4.6');
    expect(toKiloModelId('other/model')).toBe('other/model');
  });
});

describe('writeKiloCliConfig', () => {
  it('returns false when feature flag is disabled', () => {
    const { deps, written } = fakeDeps();
    const result = writeKiloCliConfig({ KILOCLAW_KILO_CLI: 'false' }, '/tmp/kilo', deps);

    expect(result).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('returns false when feature flag is not set', () => {
    const { deps, written } = fakeDeps();
    const result = writeKiloCliConfig({}, '/tmp/kilo', deps);

    expect(result).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('returns false when KILOCODE_API_KEY is missing', () => {
    const { deps, written } = fakeDeps();
    const result = writeKiloCliConfig({ KILOCLAW_KILO_CLI: 'true' }, '/tmp/kilo', deps);

    expect(result).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('seeds config on fresh install with no existing config', () => {
    const { deps, written, dirs } = fakeDeps();
    const result = writeKiloCliConfig(baseEnv(), '/tmp/kilo', deps);

    expect(result).toBe(true);
    expect(dirs).toContain('/tmp/kilo');
    expect(deps.mkdirSync).toHaveBeenCalledWith('/tmp/kilo', { recursive: true });

    expect(written.length).toBeGreaterThanOrEqual(1);
    const seedConfig = JSON.parse(written[0].data);
    expect(seedConfig.$schema).toBe('https://app.kilo.ai/config.json');
    // No provider block — KiloAuthPlugin auto-registers via KILO_API_KEY env var
    expect(seedConfig.provider).toBeUndefined();
    // No model when KILOCODE_DEFAULT_MODEL is not set
    expect(seedConfig.model).toBeUndefined();
    expect(seedConfig.permission.edit).toBe('allow');
    expect(seedConfig.permission.bash).toBe('allow');
    expect(written[0].mode).toBe(0o600);
  });

  it('includes model in seed config when KILOCODE_DEFAULT_MODEL is set', () => {
    const { deps, written } = fakeDeps();
    const env = baseEnv({ KILOCODE_DEFAULT_MODEL: 'kilocode/anthropic/claude-opus-4.6' });
    const result = writeKiloCliConfig(env, '/tmp/kilo', deps);

    expect(result).toBe(true);
    expect(written.length).toBeGreaterThanOrEqual(1);
    const seedConfig = JSON.parse(written[0].data);
    expect(seedConfig.model).toBe('kilo/anthropic/claude-opus-4.6');
    expect(seedConfig.permission.edit).toBe('allow');
  });

  it('does not seed config on fresh install when config already exists', () => {
    const existing = JSON.stringify({ permission: { edit: 'allow', bash: 'allow' } });
    const { deps, written } = fakeDeps(existing);
    const result = writeKiloCliConfig(baseEnv(), '/tmp/kilo', deps);

    expect(result).toBe(true);
    // No seed (file exists), no patch (no KILOCODE_API_BASE_URL)
    expect(written).toHaveLength(0);
  });

  it('does not seed config on non-fresh boot', () => {
    const { deps, written } = fakeDeps();
    const env = baseEnv({ KILOCLAW_FRESH_INSTALL: 'false' });
    const result = writeKiloCliConfig(env, '/tmp/kilo', deps);

    expect(result).toBe(true);
    // No config exists, not fresh → no seed, no patch (nothing to patch)
    expect(written).toHaveLength(0);
  });

  it('patches base URL on existing config using provider.kilo, stripping path to origin', () => {
    const existing = JSON.stringify({ permission: { edit: 'allow', bash: 'allow' } });
    const { deps, written } = fakeDeps(existing);
    const env = baseEnv({
      KILOCLAW_FRESH_INSTALL: 'false',
      KILOCODE_API_BASE_URL: 'https://tunnel.example.com/api/gateway',
    });

    writeKiloCliConfig(env, '/tmp/kilo', deps);

    expect(written).toHaveLength(1);
    const config = JSON.parse(written[0].data);
    expect(config.provider.kilo.options.baseURL).toBe('https://tunnel.example.com');
  });

  it('patches model from KILOCODE_DEFAULT_MODEL on existing config', () => {
    const existing = JSON.stringify({ permission: { edit: 'allow', bash: 'allow' } });
    const { deps, written } = fakeDeps(existing);
    const env = baseEnv({
      KILOCLAW_FRESH_INSTALL: 'false',
      KILOCODE_DEFAULT_MODEL: 'kilocode/openai/gpt-5',
    });

    writeKiloCliConfig(env, '/tmp/kilo', deps);

    expect(written).toHaveLength(1);
    const config = JSON.parse(written[0].data);
    expect(config.model).toBe('kilo/openai/gpt-5');
  });

  it('patches both model and base URL when both are set', () => {
    const existing = JSON.stringify({ permission: { edit: 'allow', bash: 'allow' } });
    const { deps, written } = fakeDeps(existing);
    const env = baseEnv({
      KILOCLAW_FRESH_INSTALL: 'false',
      KILOCODE_DEFAULT_MODEL: 'kilocode/openai/gpt-5',
      KILOCODE_API_BASE_URL: 'https://tunnel.example.com/api/gateway',
    });

    writeKiloCliConfig(env, '/tmp/kilo', deps);

    expect(written).toHaveLength(1);
    const config = JSON.parse(written[0].data);
    expect(config.model).toBe('kilo/openai/gpt-5');
  });

  it('does not set model when KILOCODE_DEFAULT_MODEL is absent', () => {
    const existing = JSON.stringify({ permission: { edit: 'allow', bash: 'allow' } });
    const { deps, written } = fakeDeps(existing);
    const env = baseEnv({
      KILOCLAW_FRESH_INSTALL: 'false',
      KILOCODE_API_BASE_URL: 'https://tunnel.example.com/api/gateway',
    });

    writeKiloCliConfig(env, '/tmp/kilo', deps);

    expect(written).toHaveLength(1);
    const config = JSON.parse(written[0].data);
    expect(config.model).toBeUndefined();
  });

  it('creates provider structure when patching base URL on minimal config', () => {
    const existing = JSON.stringify({});
    const { deps, written } = fakeDeps(existing);
    const env = baseEnv({
      KILOCLAW_FRESH_INSTALL: 'false',
      KILOCODE_API_BASE_URL: 'https://tunnel.example.com/api/gateway',
    });

    writeKiloCliConfig(env, '/tmp/kilo', deps);

    const config = JSON.parse(written[0].data);
    expect(config.provider.kilo.options.baseURL).toBe('https://tunnel.example.com');
  });

  it('does not write when no env overrides set', () => {
    const existing = JSON.stringify({ permission: { edit: 'allow' } });
    const { deps, written } = fakeDeps(existing);
    const env = baseEnv({ KILOCLAW_FRESH_INSTALL: 'false' });

    writeKiloCliConfig(env, '/tmp/kilo', deps);

    // No KILOCODE_API_BASE_URL → no patch needed, no write
    expect(written).toHaveLength(0);
  });

  it('skips patch gracefully when config file contains corrupt JSON', () => {
    const { deps, written } = fakeDeps('not valid json {{{');
    const env = baseEnv({
      KILOCLAW_FRESH_INSTALL: 'false',
      KILOCODE_API_BASE_URL: 'https://tunnel.example.com/api/gateway',
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = writeKiloCliConfig(env, '/tmp/kilo', deps);

    expect(result).toBe(true);
    expect(written).toHaveLength(0); // no write on corrupt JSON
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[kilo-cli] Failed to patch config'),
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it('seeds config and then patches base URL on fresh install', () => {
    const { deps, written } = fakeDeps();

    let seeded = false;
    (deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
      if (filePath.endsWith('opencode.json')) return seeded;
      return false;
    });
    (deps.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      (filePath: string, data: string, opts: { mode: number }) => {
        written.push({ path: filePath, data, mode: opts.mode });
        if (filePath.endsWith('opencode.json')) seeded = true;
      }
    );
    (deps.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (seeded) return written[written.length - 1].data;
      throw new Error('ENOENT');
    });

    const env = baseEnv({
      KILOCODE_API_BASE_URL: 'https://tunnel.example.com/api/gateway',
    });

    const result = writeKiloCliConfig(env, '/tmp/kilo', deps);

    expect(result).toBe(true);
    expect(written).toHaveLength(2); // seed + patch

    const finalConfig = JSON.parse(written[1].data);
    expect(finalConfig.$schema).toBe('https://app.kilo.ai/config.json');
    expect(finalConfig.provider.kilo.options.baseURL).toBe('https://tunnel.example.com');
    expect(finalConfig.model).toBeUndefined();
  });
});
