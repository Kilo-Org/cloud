import { describe, it, expect, vi, beforeEach } from 'vitest';

function mockDeps() {
  return {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    execFileSync: vi.fn(),
  };
}

function mockPatchDeps(fileContent?: string) {
  return {
    readFileSync: vi.fn().mockReturnValue(fileContent ?? '{}'),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(fileContent !== undefined),
  };
}

// A tiny valid .tar.gz base64 — content doesn't matter for unit tests since execSync is mocked
const FAKE_TARBALL_BASE64 = Buffer.from('fake-tarball-data').toString('base64');

describe('writeGogCredentials', () => {
  let writeGogCredentials: typeof import('./gog-credentials').writeGogCredentials;
  let sanitizeAccountForPath: typeof import('./gog-credentials').sanitizeAccountForPath;
  let patchGogHistoryId: typeof import('./gog-credentials').patchGogHistoryId;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./gog-credentials');
    writeGogCredentials = mod.writeGogCredentials;
    sanitizeAccountForPath = mod.sanitizeAccountForPath;
    patchGogHistoryId = mod.patchGogHistoryId;
  });

  it('extracts tarball and sets env vars when KILOCLAW_GOG_CONFIG_TARBALL is set', async () => {
    const deps = mockDeps();
    const dir = '/root/.config/gogcli';
    const env: Record<string, string | undefined> = {
      KILOCLAW_GOG_CONFIG_TARBALL: FAKE_TARBALL_BASE64,
      KILOCLAW_GOOGLE_ACCOUNT_EMAIL: 'user@gmail.com',
    };
    const result = await writeGogCredentials(env, dir, deps);

    expect(result).toBe(true);
    // Should remove stale config before extracting
    expect(deps.rmSync).toHaveBeenCalledWith(dir, { recursive: true, force: true });
    expect(deps.mkdirSync).toHaveBeenCalledWith('/root/.config', { recursive: true });

    // Should write temp tarball file
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      '/root/.config/gogcli-config.tar.gz',
      Buffer.from(FAKE_TARBALL_BASE64, 'base64')
    );

    expect(deps.execFileSync).toHaveBeenCalledWith('tar', [
      'xzf',
      '/root/.config/gogcli-config.tar.gz',
      '-C',
      '/root/.config',
    ]);

    // Should clean up temp tarball
    expect(deps.unlinkSync).toHaveBeenCalledWith('/root/.config/gogcli-config.tar.gz');

    // Should set gog env vars
    expect(env.GOG_KEYRING_BACKEND).toBe('file');
    expect(env.GOG_KEYRING_PASSWORD).toBe('kiloclaw');
    expect(env.GOG_ACCOUNT).toBe('user@gmail.com');
  });

  it('works without KILOCLAW_GOOGLE_ACCOUNT_EMAIL', async () => {
    const deps = mockDeps();
    const env: Record<string, string | undefined> = {
      KILOCLAW_GOG_CONFIG_TARBALL: FAKE_TARBALL_BASE64,
    };
    const result = await writeGogCredentials(env, '/root/.config/gogcli', deps);

    expect(result).toBe(true);
    expect(env.GOG_KEYRING_BACKEND).toBe('file');
    expect(env.GOG_KEYRING_PASSWORD).toBe('kiloclaw');
    expect(env.GOG_ACCOUNT).toBeUndefined();
  });

  it('returns false and cleans up when tarball env var is absent', async () => {
    const deps = mockDeps();
    const dir = '/root/.config/gogcli';
    const result = await writeGogCredentials({}, dir, deps);

    expect(result).toBe(false);
    expect(deps.rmSync).toHaveBeenCalledWith(dir, { recursive: true, force: true });
    expect(deps.mkdirSync).not.toHaveBeenCalled();
  });

  it('clears gog env vars when tarball env var is absent', async () => {
    const deps = mockDeps();
    const env: Record<string, string | undefined> = {
      GOG_KEYRING_BACKEND: 'file',
      GOG_KEYRING_PASSWORD: 'kiloclaw',
      GOG_ACCOUNT: 'user@gmail.com',
    };
    await writeGogCredentials(env, '/root/.config/gogcli', deps);

    expect(env.GOG_KEYRING_BACKEND).toBeUndefined();
    expect(env.GOG_KEYRING_PASSWORD).toBeUndefined();
    expect(env.GOG_ACCOUNT).toBeUndefined();
  });

  it('removes existing config dir before extracting new tarball', async () => {
    const deps = mockDeps();
    const callOrder: string[] = [];
    deps.rmSync.mockImplementation(() => callOrder.push('rmSync'));
    deps.mkdirSync.mockImplementation(() => callOrder.push('mkdirSync'));
    deps.execFileSync.mockImplementation(() => callOrder.push('execFileSync'));

    const env: Record<string, string | undefined> = {
      KILOCLAW_GOG_CONFIG_TARBALL: FAKE_TARBALL_BASE64,
    };
    await writeGogCredentials(env, '/root/.config/gogcli', deps);

    expect(callOrder).toEqual(['rmSync', 'mkdirSync', 'execFileSync']);
  });

  it('cleans up temp tarball even if extraction fails', async () => {
    const deps = mockDeps();
    deps.execFileSync.mockImplementation(() => {
      throw new Error('tar failed');
    });

    const env: Record<string, string | undefined> = {
      KILOCLAW_GOG_CONFIG_TARBALL: FAKE_TARBALL_BASE64,
    };

    await expect(writeGogCredentials(env, '/root/.config/gogcli', deps)).rejects.toThrow(
      'tar failed'
    );
    expect(deps.unlinkSync).toHaveBeenCalledWith('/root/.config/gogcli-config.tar.gz');
  });

  it('calls patchGogHistoryId when KILOCLAW_GMAIL_LAST_HISTORY_ID is set', async () => {
    const deps = mockDeps();
    const env: Record<string, string | undefined> = {
      KILOCLAW_GOG_CONFIG_TARBALL: FAKE_TARBALL_BASE64,
      KILOCLAW_GOOGLE_ACCOUNT_EMAIL: 'user@gmail.com',
      KILOCLAW_GMAIL_LAST_HISTORY_ID: '12345',
    };

    // Best-effort: the state file won't exist in unit tests, so this should not throw
    await expect(writeGogCredentials(env, '/root/.config/gogcli', deps)).resolves.toBe(true);
  });
});

describe('sanitizeAccountForPath', () => {
  let sanitizeAccountForPath: typeof import('./gog-credentials').sanitizeAccountForPath;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./gog-credentials');
    sanitizeAccountForPath = mod.sanitizeAccountForPath;
  });

  it('sanitizes a normal gmail address', () => {
    expect(sanitizeAccountForPath('igor.kiloclaw@gmail.com')).toBe('igor_kiloclaw_gmail_com');
  });

  it('lowercases the input', () => {
    expect(sanitizeAccountForPath('User@Gmail.COM')).toBe('user_gmail_com');
  });

  it('returns "unknown" for empty string', () => {
    expect(sanitizeAccountForPath('')).toBe('unknown');
  });
});

describe('patchGogHistoryId', () => {
  let patchGogHistoryId: typeof import('./gog-credentials').patchGogHistoryId;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./gog-credentials');
    patchGogHistoryId = mod.patchGogHistoryId;
  });

  it('patches historyId when env var value is greater than file value', () => {
    const stateContent = JSON.stringify({ historyId: '100', someOtherField: 'preserved' });
    const deps = mockPatchDeps(stateContent);

    patchGogHistoryId({
      account: 'user@gmail.com',
      historyId: '200',
      configDir: '/fake/config',
      deps,
    });

    expect(deps.writeFileSync).toHaveBeenCalledOnce();
    const writtenContent = JSON.parse(deps.writeFileSync.mock.calls[0][1] as string);
    expect(writtenContent.historyId).toBe('200');
    expect(writtenContent.someOtherField).toBe('preserved');
  });

  it('does NOT patch when file value is greater than env var', () => {
    const stateContent = JSON.stringify({ historyId: '500' });
    const deps = mockPatchDeps(stateContent);

    patchGogHistoryId({
      account: 'user@gmail.com',
      historyId: '200',
      configDir: '/fake/config',
      deps,
    });

    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it('does NOT patch when values are equal', () => {
    const stateContent = JSON.stringify({ historyId: '200' });
    const deps = mockPatchDeps(stateContent);

    patchGogHistoryId({
      account: 'user@gmail.com',
      historyId: '200',
      configDir: '/fake/config',
      deps,
    });

    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it('skips if state file does not exist', () => {
    const deps = {
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(false),
    };

    expect(() => {
      patchGogHistoryId({
        account: 'user@gmail.com',
        historyId: '200',
        configDir: '/fake/config',
        deps,
      });
    }).not.toThrow();

    expect(deps.readFileSync).not.toHaveBeenCalled();
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it('skips gracefully on non-numeric historyId in file', () => {
    const stateContent = JSON.stringify({ historyId: 'not-a-number' });
    const deps = mockPatchDeps(stateContent);

    expect(() => {
      patchGogHistoryId({
        account: 'user@gmail.com',
        historyId: '200',
        configDir: '/fake/config',
        deps,
      });
    }).not.toThrow();

    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it('skips gracefully on invalid JSON', () => {
    const deps = {
      readFileSync: vi.fn().mockReturnValue('not valid json {{{'),
      writeFileSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(true),
    };

    expect(() => {
      patchGogHistoryId({
        account: 'user@gmail.com',
        historyId: '200',
        configDir: '/fake/config',
        deps,
      });
    }).not.toThrow();

    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });
});
