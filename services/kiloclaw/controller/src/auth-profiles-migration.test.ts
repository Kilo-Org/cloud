import { describe, expect, it, vi } from 'vitest';
import {
  migrateKilocodeAuthProfilesToKeyRef,
  hardenAuthProfileMigrationBackups,
  type AuthProfilesMigrationDeps,
} from './auth-profiles-migration';

type ProfileStore = {
  version?: number;
  profiles: Record<string, Record<string, unknown>>;
};

function parseStore(raw: string | undefined): ProfileStore {
  if (raw === undefined) throw new Error('file not found');
  return JSON.parse(raw) as ProfileStore;
}

type InMemoryFs = {
  files: Map<string, string>;
  dirs: Set<string>;
};

function createFs(): InMemoryFs {
  return { files: new Map(), dirs: new Set() };
}

function seedDir(fs: InMemoryFs, dir: string): void {
  fs.dirs.add(dir);
}

function seedFile(fs: InMemoryFs, filePath: string, content: string): void {
  fs.files.set(filePath, content);
}

function fsDeps(fs: InMemoryFs): AuthProfilesMigrationDeps {
  return {
    existsSync: p => fs.files.has(p) || fs.dirs.has(p),
    readdirSync: dir => {
      const entries = new Set<string>();
      const dirPrefix = dir.endsWith('/') ? dir : `${dir}/`;
      for (const d of fs.dirs) {
        if (d.startsWith(dirPrefix)) {
          const rest = d.slice(dirPrefix.length);
          const top = rest.split('/')[0];
          if (top) entries.add(top);
        }
      }
      for (const f of fs.files.keys()) {
        if (f.startsWith(dirPrefix)) {
          const rest = f.slice(dirPrefix.length);
          const top = rest.split('/')[0];
          if (top) entries.add(top);
        }
      }
      return [...entries];
    },
    statSync: p => ({ isDirectory: () => fs.dirs.has(p) }),
    readFileSync: p => {
      const data = fs.files.get(p);
      if (data === undefined) throw new Error(`ENOENT: ${p}`);
      return data;
    },
    writeFileSync: (p, data) => {
      fs.files.set(p, data);
    },
    renameSync: (oldPath, newPath) => {
      const data = fs.files.get(oldPath);
      if (data === undefined) throw new Error(`ENOENT: ${oldPath}`);
      fs.files.delete(oldPath);
      fs.files.set(newPath, data);
    },
    unlinkSync: p => {
      fs.files.delete(p);
    },
    chmodSync: () => undefined,
  };
}

function plaintextStore(): Record<string, unknown> {
  return {
    version: 1,
    profiles: {
      'kilocode:default': {
        type: 'api_key',
        provider: 'kilocode',
        key: 'secret-literal-key',
      },
    },
  };
}

function keyRefStore(): Record<string, unknown> {
  return {
    version: 1,
    profiles: {
      'kilocode:default': {
        type: 'api_key',
        provider: 'kilocode',
        keyRef: { source: 'env', provider: 'default', id: 'KILOCODE_API_KEY' },
      },
    },
  };
}

describe('migrateKilocodeAuthProfilesToKeyRef', () => {
  const ROOT = '/root/.openclaw';
  const MAIN = `${ROOT}/agents/main/agent/auth-profiles.json`;

  it('converts plaintext kilocode key to env-backed keyRef', () => {
    const fs = createFs();
    seedDir(fs, `${ROOT}/agents`);
    seedDir(fs, `${ROOT}/agents/main`);
    seedFile(fs, MAIN, JSON.stringify(plaintextStore()));

    const report = migrateKilocodeAuthProfilesToKeyRef(ROOT, fsDeps(fs));

    expect(report).toEqual({
      filesScanned: 1,
      filesModified: 1,
      profilesMigrated: 1,
      filesFailed: 0,
    });

    const written = parseStore(fs.files.get(MAIN));
    expect(written.profiles['kilocode:default']).toEqual({
      type: 'api_key',
      provider: 'kilocode',
      keyRef: { source: 'env', provider: 'default', id: 'KILOCODE_API_KEY' },
    });
    expect(written.profiles['kilocode:default']).not.toHaveProperty('key');
  });

  it('is idempotent — profiles already in keyRef form are untouched', () => {
    const fs = createFs();
    seedDir(fs, `${ROOT}/agents`);
    seedDir(fs, `${ROOT}/agents/main`);
    seedFile(fs, MAIN, JSON.stringify(keyRefStore()));

    const before = fs.files.get(MAIN);
    const report = migrateKilocodeAuthProfilesToKeyRef(ROOT, fsDeps(fs));

    expect(report).toEqual({
      filesScanned: 1,
      filesModified: 0,
      profilesMigrated: 0,
      filesFailed: 0,
    });
    expect(fs.files.get(MAIN)).toBe(before);
  });

  it('leaves non-kilocode provider profiles untouched', () => {
    const fs = createFs();
    seedDir(fs, `${ROOT}/agents`);
    seedDir(fs, `${ROOT}/agents/main`);
    seedFile(
      fs,
      MAIN,
      JSON.stringify({
        version: 1,
        profiles: {
          'openai:default': {
            type: 'api_key',
            provider: 'openai',
            key: 'sk-plaintext',
          },
        },
      })
    );

    const before = fs.files.get(MAIN);
    const report = migrateKilocodeAuthProfilesToKeyRef(ROOT, fsDeps(fs));

    expect(report.profilesMigrated).toBe(0);
    expect(fs.files.get(MAIN)).toBe(before);
  });

  it('leaves OAuth-mode profiles untouched (different credential type)', () => {
    const fs = createFs();
    seedDir(fs, `${ROOT}/agents`);
    seedDir(fs, `${ROOT}/agents/main`);
    seedFile(
      fs,
      MAIN,
      JSON.stringify({
        version: 1,
        profiles: {
          'kilocode:oauth': {
            type: 'oauth',
            provider: 'kilocode',
            accessToken: 'x',
          },
        },
      })
    );

    const before = fs.files.get(MAIN);
    const report = migrateKilocodeAuthProfilesToKeyRef(ROOT, fsDeps(fs));

    expect(report.profilesMigrated).toBe(0);
    expect(fs.files.get(MAIN)).toBe(before);
  });

  it('migrates across multiple agent directories', () => {
    const fs = createFs();
    seedDir(fs, `${ROOT}/agents`);
    seedDir(fs, `${ROOT}/agents/main`);
    seedDir(fs, `${ROOT}/agents/coding`);
    seedDir(fs, `${ROOT}/agents/disabled`);
    seedFile(fs, MAIN, JSON.stringify(plaintextStore()));
    seedFile(
      fs,
      `${ROOT}/agents/coding/agent/auth-profiles.json`,
      JSON.stringify(plaintextStore())
    );
    // No auth-profiles.json under `disabled` — should be skipped silently.

    const report = migrateKilocodeAuthProfilesToKeyRef(ROOT, fsDeps(fs));

    expect(report).toEqual({
      filesScanned: 2,
      filesModified: 2,
      profilesMigrated: 2,
      filesFailed: 0,
    });
  });

  it('skips malformed JSON with a warning but does not throw', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fs = createFs();
    seedDir(fs, `${ROOT}/agents`);
    seedDir(fs, `${ROOT}/agents/main`);
    seedFile(fs, MAIN, '{ not valid json');

    const report = migrateKilocodeAuthProfilesToKeyRef(ROOT, fsDeps(fs));

    expect(report).toEqual({
      filesScanned: 1,
      filesModified: 0,
      profilesMigrated: 0,
      filesFailed: 0,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('writes with 0o600 permissions', () => {
    const fs = createFs();
    seedDir(fs, `${ROOT}/agents`);
    seedDir(fs, `${ROOT}/agents/main`);
    seedFile(fs, MAIN, JSON.stringify(plaintextStore()));

    const chmodSync = vi.fn();
    const deps: AuthProfilesMigrationDeps = { ...fsDeps(fs), chmodSync };

    migrateKilocodeAuthProfilesToKeyRef(ROOT, deps);

    expect(chmodSync).toHaveBeenCalled();
    const [[, mode]] = chmodSync.mock.calls;
    expect(mode).toBe(0o600);
  });

  it('is a no-op when the agents dir does not exist', () => {
    const fs = createFs();

    const report = migrateKilocodeAuthProfilesToKeyRef(ROOT, fsDeps(fs));

    expect(report).toEqual({
      filesScanned: 0,
      filesModified: 0,
      profilesMigrated: 0,
      filesFailed: 0,
    });
  });

  it('reports filesFailed (and migrates nothing) when the rewrite throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fs = createFs();
    seedDir(fs, `${ROOT}/agents`);
    seedDir(fs, `${ROOT}/agents/main`);
    seedFile(fs, MAIN, JSON.stringify(plaintextStore()));
    const deps: AuthProfilesMigrationDeps = {
      ...fsDeps(fs),
      writeFileSync: () => {
        throw new Error('ENOSPC');
      },
    };

    const report = migrateKilocodeAuthProfilesToKeyRef(ROOT, deps);

    expect(report).toEqual({
      filesScanned: 1,
      filesModified: 0,
      profilesMigrated: 0,
      filesFailed: 1,
    });
    // The plaintext is still on disk because the write failed.
    expect(fs.files.get(MAIN)).toContain('secret-literal-key');
    warnSpy.mockRestore();
  });

  it('preserves unrelated profile fields when migrating', () => {
    const fs = createFs();
    seedDir(fs, `${ROOT}/agents`);
    seedDir(fs, `${ROOT}/agents/main`);
    seedFile(
      fs,
      MAIN,
      JSON.stringify({
        version: 2,
        profiles: {
          'kilocode:default': {
            type: 'api_key',
            provider: 'kilocode',
            key: 'literal',
            email: 'user@example.com',
            metadata: { createdBy: 'onboard' },
          },
        },
      })
    );

    migrateKilocodeAuthProfilesToKeyRef(ROOT, fsDeps(fs));

    const written = parseStore(fs.files.get(MAIN));
    expect(written.version).toBe(2);
    expect(written.profiles['kilocode:default']).toEqual({
      type: 'api_key',
      provider: 'kilocode',
      keyRef: { source: 'env', provider: 'default', id: 'KILOCODE_API_KEY' },
      email: 'user@example.com',
      metadata: { createdBy: 'onboard' },
    });
  });

  it('converts the historical api_key alias (not just key) to a keyRef', () => {
    const fs = createFs();
    seedDir(fs, `${ROOT}/agents`);
    seedDir(fs, `${ROOT}/agents/main`);
    seedFile(
      fs,
      MAIN,
      JSON.stringify({
        version: 1,
        profiles: {
          'kilocode:default': {
            type: 'api_key',
            provider: 'kilocode',
            api_key: 'legacy-alias-key',
          },
        },
      })
    );

    const report = migrateKilocodeAuthProfilesToKeyRef(ROOT, fsDeps(fs));

    expect(report.profilesMigrated).toBe(1);
    const profile = parseStore(fs.files.get(MAIN)).profiles['kilocode:default'];
    expect(profile).toEqual({
      type: 'api_key',
      provider: 'kilocode',
      keyRef: { source: 'env', provider: 'default', id: 'KILOCODE_API_KEY' },
    });
    expect(profile).not.toHaveProperty('api_key');
    expect(profile).not.toHaveProperty('key');
  });
});

describe('hardenAuthProfileMigrationBackups', () => {
  const ROOT = '/root/.openclaw';
  const AGENT_DIR = `${ROOT}/agents/main/agent`;
  const BAK = `${AGENT_DIR}/auth-profiles.json.sqlite-import.1781117548412.bak`;

  function seedAgentDir(fs: InMemoryFs): void {
    seedDir(fs, `${ROOT}/agents`);
    seedDir(fs, `${ROOT}/agents/main`);
    seedDir(fs, AGENT_DIR);
  }

  it('tightens the sqlite-import backup to 0o600 and retains it (recovery copy)', () => {
    const fs = createFs();
    seedAgentDir(fs);
    seedFile(fs, BAK, JSON.stringify(plaintextStore()));
    const chmodSync = vi.fn();

    const report = hardenAuthProfileMigrationBackups(ROOT, { ...fsDeps(fs), chmodSync });

    expect(report).toEqual({ dirsScanned: 1, backupsHardened: 1, backupsFailed: 0 });
    expect(chmodSync).toHaveBeenCalledWith(BAK, 0o600);
    // The backup is retained, not deleted.
    expect(fs.files.has(BAK)).toBe(true);
  });

  it('hardens every known migration backup suffix and leaves unrelated files alone', () => {
    const fs = createFs();
    seedAgentDir(fs);
    const backups = [
      `${AGENT_DIR}/auth-profiles.json.sqlite-import.1.bak`,
      `${AGENT_DIR}/auth-profiles.json.legacy-flat.2.bak`,
      `${AGENT_DIR}/auth-profiles.json.api-key-alias.3.bak`,
      `${AGENT_DIR}/auth-profiles.json.aws-sdk-profile.4.bak`,
      `${AGENT_DIR}/auth-profiles.json.openai-provider-unification.5.bak`,
      `${AGENT_DIR}/auth-profiles.json.oauth-ref.6.bak`,
    ];
    for (const b of backups) seedFile(fs, b, JSON.stringify(plaintextStore()));
    // Not migration backups — must be left untouched.
    for (const keep of [
      `${AGENT_DIR}/openclaw-agent.sqlite`,
      `${AGENT_DIR}/models.json`,
      `${AGENT_DIR}/unrelated.bak`,
      `${AGENT_DIR}/auth-profiles.json.unknown-migration.7.bak`,
    ]) {
      seedFile(fs, keep, 'x');
    }
    const chmodSync = vi.fn();

    const report = hardenAuthProfileMigrationBackups(ROOT, { ...fsDeps(fs), chmodSync });

    expect(report.backupsHardened).toBe(backups.length);
    expect(chmodSync).toHaveBeenCalledTimes(backups.length);
    for (const b of backups) expect(chmodSync).toHaveBeenCalledWith(b, 0o600);
  });

  it('counts a failure when chmod throws, without throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fs = createFs();
    seedAgentDir(fs);
    seedFile(fs, BAK, JSON.stringify(plaintextStore()));
    const deps: AuthProfilesMigrationDeps = {
      ...fsDeps(fs),
      chmodSync: () => {
        throw new Error('EPERM');
      },
    };

    const report = hardenAuthProfileMigrationBackups(ROOT, deps);

    expect(report).toEqual({ dirsScanned: 1, backupsHardened: 0, backupsFailed: 1 });
    warnSpy.mockRestore();
  });

  it('scans multiple agent directories', () => {
    const fs = createFs();
    seedDir(fs, `${ROOT}/agents`);
    for (const agent of ['main', 'coding']) {
      seedDir(fs, `${ROOT}/agents/${agent}`);
      seedDir(fs, `${ROOT}/agents/${agent}/agent`);
      seedFile(fs, `${ROOT}/agents/${agent}/agent/auth-profiles.json.sqlite-import.99.bak`, 'x');
    }
    const chmodSync = vi.fn();

    const report = hardenAuthProfileMigrationBackups(ROOT, { ...fsDeps(fs), chmodSync });

    expect(report).toEqual({ dirsScanned: 2, backupsHardened: 2, backupsFailed: 0 });
  });

  it('is a no-op when no agent dirs exist', () => {
    const fs = createFs();

    const report = hardenAuthProfileMigrationBackups(ROOT, fsDeps(fs));

    expect(report).toEqual({ dirsScanned: 0, backupsHardened: 0, backupsFailed: 0 });
  });
});
