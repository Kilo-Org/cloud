import net from 'node:net';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensurePipelockCa,
  ensurePipelockCaBundle,
  ensurePipelockConfig,
  getOpenClawProxyEnv,
  getPipelockChildEnv,
  getPipelockSupervisorOptions,
  isPipelockEnabled,
  PIPELOCK_CA_BUNDLE,
  PIPELOCK_CA_CERT,
  PIPELOCK_CA_DIR,
  PIPELOCK_CA_KEY,
  PIPELOCK_CONFIG_DIR,
  PIPELOCK_CONFIG_PATH,
  PIPELOCK_LISTEN_HOST,
  PIPELOCK_LISTEN_PORT,
  SYSTEM_CA_BUNDLE,
  waitForListening,
  waitForPipelockReady,
  waitForSupervisorAlive,
  type PipelockDeps,
} from './pipelock';
import type { SupervisorState } from './supervisor';

// ─── Fake fs harness ─────────────────────────────────────────────────────────
//
// An in-memory fs shim is used for ensurePipelockCa / ensurePipelockConfig so
// tests can assert on exact paths, modes, and argv without touching the real
// filesystem or spawning the real pipelock binary.

type FsState = {
  files: Map<string, { data: string; mode: number }>;
  dirs: Map<string, { mode: number }>;
  execs: Array<{ cmd: string; args: string[] }>;
};

function createFsState(): FsState {
  return { files: new Map(), dirs: new Map(), execs: [] };
}

function makeDeps(state: FsState, overrides: Partial<PipelockDeps> = {}): PipelockDeps {
  const base: PipelockDeps = {
    existsSync: p => state.files.has(p) || state.dirs.has(p),
    mkdirSync: (p, opts) => {
      state.dirs.set(p, { mode: opts.mode ?? 0o755 });
    },
    readFileSync: (p, _enc) => {
      const entry = state.files.get(p);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return entry.data;
    },
    chmodSync: (p, mode) => {
      const file = state.files.get(p);
      if (file) {
        file.mode = mode;
        return;
      }
      const dir = state.dirs.get(p);
      if (dir) {
        dir.mode = mode;
        return;
      }
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
    writeFileSync: (p, data) => {
      state.files.set(p, { data, mode: 0o644 });
    },
    renameSync: (oldPath, newPath) => {
      const entry = state.files.get(oldPath);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${oldPath}`), { code: 'ENOENT' });
      state.files.delete(oldPath);
      state.files.set(newPath, entry);
    },
    unlinkSync: p => {
      if (!state.files.delete(p)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
    },
    execFileSync: (cmd, args, _opts) => {
      state.execs.push({ cmd, args });
      // Simulate pipelock tls init creating both CA files.
      if (cmd === 'pipelock' && args[0] === 'tls' && args[1] === 'init') {
        const outIdx = args.indexOf('--out');
        const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
        if (!outDir) throw new Error('fake exec: --out missing');
        state.files.set(`${outDir}/ca.pem`, { data: 'FAKE CERT', mode: 0o644 });
        // Real pipelock writes the key at 0o600. Mirror that here.
        state.files.set(`${outDir}/ca-key.pem`, { data: 'FAKE KEY', mode: 0o600 });
      }
      return '';
    },
    ...overrides,
  };
  return base;
}

// ─── isPipelockEnabled ───────────────────────────────────────────────────────

describe('isPipelockEnabled', () => {
  it('returns false when flag is unset', () => {
    expect(isPipelockEnabled({})).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isPipelockEnabled({ KILOCLAW_PIPELOCK_ENABLED: '' })).toBe(false);
  });

  it('returns false for whitespace-only', () => {
    expect(isPipelockEnabled({ KILOCLAW_PIPELOCK_ENABLED: '   ' })).toBe(false);
  });

  it('returns true for truthy values (case-insensitive, whitespace-tolerant)', () => {
    const cases = ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON', '  true  ', '\tyes\n'];
    for (const v of cases) {
      expect(isPipelockEnabled({ KILOCLAW_PIPELOCK_ENABLED: v })).toBe(true);
    }
  });

  it('returns false for explicit falsy or ambiguous values', () => {
    const cases = ['0', 'false', 'FALSE', 'no', 'off', '2', 'enabled', 'disabled', 'whatever'];
    for (const v of cases) {
      expect(isPipelockEnabled({ KILOCLAW_PIPELOCK_ENABLED: v })).toBe(false);
    }
  });
});

// ─── getOpenClawProxyEnv ─────────────────────────────────────────────────────

describe('getOpenClawProxyEnv', () => {
  it('returns empty object when flag is unset', () => {
    expect(getOpenClawProxyEnv({})).toEqual({});
  });

  it('returns empty object when flag is explicitly disabled', () => {
    expect(getOpenClawProxyEnv({ KILOCLAW_PIPELOCK_ENABLED: '0' })).toEqual({});
  });

  it('returns proxy and CA trust env vars when enabled', () => {
    const result = getOpenClawProxyEnv({ KILOCLAW_PIPELOCK_ENABLED: '1' });
    expect(Object.keys(result).sort()).toEqual([
      'CURL_CA_BUNDLE',
      'GIT_SSL_CAINFO',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'NO_PROXY',
      'NPM_CONFIG_CAFILE',
      'PIP_CERT',
      'REQUESTS_CA_BUNDLE',
      'SSL_CERT_FILE',
      'http_proxy',
      'https_proxy',
      'no_proxy',
    ]);
  });

  it('points HTTPS_PROXY and HTTP_PROXY at 127.0.0.1:8888 (loopback only)', () => {
    const result = getOpenClawProxyEnv({ KILOCLAW_PIPELOCK_ENABLED: '1' });
    const expected = `http://${PIPELOCK_LISTEN_HOST}:${PIPELOCK_LISTEN_PORT}`;
    expect(result.HTTPS_PROXY).toBe(expected);
    expect(result.https_proxy).toBe(expected);
    expect(result.HTTP_PROXY).toBe(expected);
    expect(result.http_proxy).toBe(expected);
  });

  it('excludes loopback addresses from proxy routing via NO_PROXY', () => {
    const result = getOpenClawProxyEnv({ KILOCLAW_PIPELOCK_ENABLED: '1' });
    expect(result.NO_PROXY).toBe('127.0.0.1,localhost,::1');
    expect(result.no_proxy).toBe('127.0.0.1,localhost,::1');
  });

  it('points NODE_EXTRA_CA_CERTS at the per-VM CA so intercepted TLS validates', () => {
    const result = getOpenClawProxyEnv({ KILOCLAW_PIPELOCK_ENABLED: '1' });
    expect(result.NODE_EXTRA_CA_CERTS).toBe(PIPELOCK_CA_CERT);
  });

  it('points replacement-style CA env vars at the combined CA bundle', () => {
    const result = getOpenClawProxyEnv({ KILOCLAW_PIPELOCK_ENABLED: '1' });
    expect(result.SSL_CERT_FILE).toBe(PIPELOCK_CA_BUNDLE);
    expect(result.REQUESTS_CA_BUNDLE).toBe(PIPELOCK_CA_BUNDLE);
    expect(result.CURL_CA_BUNDLE).toBe(PIPELOCK_CA_BUNDLE);
    expect(result.GIT_SSL_CAINFO).toBe(PIPELOCK_CA_BUNDLE);
    expect(result.NPM_CONFIG_CAFILE).toBe(PIPELOCK_CA_BUNDLE);
    expect(result.PIP_CERT).toBe(PIPELOCK_CA_BUNDLE);
  });
});

// ─── getPipelockChildEnv ────────────────────────────────────────────────────

describe('getPipelockChildEnv', () => {
  it('forwards only allowlisted operational env keys', () => {
    const result = getPipelockChildEnv({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/root',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
      TZ: 'UTC',
      TMPDIR: '/tmp',
      TEMP: '/tmp',
      TMP: '/tmp',
      USER: 'root',
      LOGNAME: 'root',
      LD_LIBRARY_PATH: '/usr/local/lib',
    });

    expect(Object.keys(result).sort()).toEqual(
      [
        'HOME',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'LD_LIBRARY_PATH',
        'LOGNAME',
        'PATH',
        'TEMP',
        'TMP',
        'TMPDIR',
        'TZ',
        'USER',
      ].sort()
    );
  });

  it('strips agent secrets from the inherited env', () => {
    const result = getPipelockChildEnv({
      PATH: '/usr/bin',
      KILOCODE_API_KEY: 'sk-secret-must-not-leak',
      OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
      KILOCLAW_HOOKS_TOKEN: 'hooks-token',
      KILOCLAW_ENV_KEY: 'master-key-base64',
      TELEGRAM_BOT_TOKEN: 'tg-secret',
      DISCORD_BOT_TOKEN: 'disc-secret',
      SLACK_BOT_TOKEN: 'slack-secret',
      KILOCLAW_GOG_CONFIG_TARBALL: 'b64-tarball',
      KILOCLAW_GOOGLE_ACCOUNT_EMAIL: 'agent@example.com',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
    });

    expect(result.PATH).toBe('/usr/bin');
    expect(result.KILOCODE_API_KEY).toBeUndefined();
    expect(result.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(result.KILOCLAW_HOOKS_TOKEN).toBeUndefined();
    expect(result.KILOCLAW_ENV_KEY).toBeUndefined();
    expect(result.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(result.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(result.SLACK_BOT_TOKEN).toBeUndefined();
    expect(result.KILOCLAW_GOG_CONFIG_TARBALL).toBeUndefined();
    expect(result.KILOCLAW_GOOGLE_ACCOUNT_EMAIL).toBeUndefined();
    expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('strips proxy and CA env vars (defends against caller mutation upstream)', () => {
    const result = getPipelockChildEnv({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:8888',
      https_proxy: 'http://127.0.0.1:8888',
      HTTP_PROXY: 'http://127.0.0.1:8888',
      http_proxy: 'http://127.0.0.1:8888',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      NODE_EXTRA_CA_CERTS: '/root/.pipelock/ca.pem',
      SSL_CERT_FILE: '/root/.pipelock/ca-bundle.pem',
      REQUESTS_CA_BUNDLE: '/root/.pipelock/ca-bundle.pem',
      CURL_CA_BUNDLE: '/root/.pipelock/ca-bundle.pem',
      GIT_SSL_CAINFO: '/root/.pipelock/ca-bundle.pem',
      NPM_CONFIG_CAFILE: '/root/.pipelock/ca-bundle.pem',
      PIP_CERT: '/root/.pipelock/ca-bundle.pem',
    });

    expect(result.HTTPS_PROXY).toBeUndefined();
    expect(result.https_proxy).toBeUndefined();
    expect(result.HTTP_PROXY).toBeUndefined();
    expect(result.http_proxy).toBeUndefined();
    expect(result.NO_PROXY).toBeUndefined();
    expect(result.no_proxy).toBeUndefined();
    expect(result.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(result.SSL_CERT_FILE).toBeUndefined();
    expect(result.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(result.CURL_CA_BUNDLE).toBeUndefined();
    expect(result.GIT_SSL_CAINFO).toBeUndefined();
    expect(result.NPM_CONFIG_CAFILE).toBeUndefined();
    expect(result.PIP_CERT).toBeUndefined();
  });

  it('skips allowlisted keys that are not present in the source env', () => {
    const result = getPipelockChildEnv({ PATH: '/usr/bin' });

    expect(result).toEqual({ PATH: '/usr/bin' });
    expect('HOME' in result).toBe(false);
    expect('LANG' in result).toBe(false);
  });
});

// ─── getPipelockSupervisorOptions ────────────────────────────────────────────

describe('getPipelockSupervisorOptions', () => {
  it('returns null when flag is unset', () => {
    expect(getPipelockSupervisorOptions({})).toBeNull();
  });

  it('returns null when flag is explicitly disabled', () => {
    expect(getPipelockSupervisorOptions({ KILOCLAW_PIPELOCK_ENABLED: 'false' })).toBeNull();
  });

  it('returns pipelock run --config invocation when enabled', () => {
    const opts = getPipelockSupervisorOptions({ KILOCLAW_PIPELOCK_ENABLED: '1' });
    expect(opts).toEqual({
      command: 'pipelock',
      args: ['run', '--config', PIPELOCK_CONFIG_PATH],
    });
  });
});

// ─── ensurePipelockCa ────────────────────────────────────────────────────────

describe('ensurePipelockCa', () => {
  it('no-ops when both ca.pem and ca-key.pem already exist (idempotent)', () => {
    const state = createFsState();
    state.files.set(PIPELOCK_CA_CERT, { data: 'existing cert', mode: 0o644 });
    state.files.set(PIPELOCK_CA_KEY, { data: 'existing key', mode: 0o600 });
    const deps = makeDeps(state);

    ensurePipelockCa(deps);

    expect(state.execs).toEqual([]);
    expect(state.files.get(PIPELOCK_CA_CERT)?.data).toBe('existing cert');
    expect(state.files.get(PIPELOCK_CA_KEY)?.data).toBe('existing key');
  });

  it('creates /root/.pipelock with mode 0o700 when starting clean', () => {
    const state = createFsState();
    const deps = makeDeps(state);

    ensurePipelockCa(deps);

    expect(state.dirs.get(PIPELOCK_CA_DIR)).toEqual({ mode: 0o700 });
  });

  it('invokes pipelock tls init with --out on a clean VM', () => {
    const state = createFsState();
    const deps = makeDeps(state);

    ensurePipelockCa(deps);

    expect(state.execs).toHaveLength(1);
    expect(state.execs[0]).toEqual({
      cmd: 'pipelock',
      args: ['tls', 'init', '--out', PIPELOCK_CA_DIR],
    });
  });

  it('defensively chmods ca-key.pem to 0o600 after init (belt and suspenders)', () => {
    const state = createFsState();
    // Simulate a hypothetical future pipelock that writes the key at 0o644.
    const deps = makeDeps(state, {
      execFileSync: (cmd, args) => {
        state.execs.push({ cmd, args });
        const outIdx = args.indexOf('--out');
        const outDir = outIdx >= 0 ? args[outIdx + 1] : '';
        state.files.set(`${outDir}/ca.pem`, { data: 'C', mode: 0o644 });
        state.files.set(`${outDir}/ca-key.pem`, { data: 'K', mode: 0o644 });
        return '';
      },
    });

    ensurePipelockCa(deps);

    expect(state.files.get(PIPELOCK_CA_KEY)?.mode).toBe(0o600);
  });

  it('throws on partial state (ca.pem present, ca-key.pem missing), failing closed', () => {
    const state = createFsState();
    state.files.set(PIPELOCK_CA_CERT, { data: 'orphan cert', mode: 0o644 });
    const deps = makeDeps(state);

    expect(() => ensurePipelockCa(deps)).toThrow(/inconsistent/i);
    expect(state.execs).toEqual([]);
  });

  it('throws on partial state (ca-key.pem present, ca.pem missing), failing closed', () => {
    const state = createFsState();
    state.files.set(PIPELOCK_CA_KEY, { data: 'orphan key', mode: 0o600 });
    const deps = makeDeps(state);

    expect(() => ensurePipelockCa(deps)).toThrow(/inconsistent/i);
    expect(state.execs).toEqual([]);
  });

  it('throws when pipelock tls init exits non-zero', () => {
    const state = createFsState();
    const deps = makeDeps(state, {
      execFileSync: () => {
        throw new Error('pipelock tls init: exit 1');
      },
    });

    expect(() => ensurePipelockCa(deps)).toThrow(/exit 1/);
  });

  it('throws when init succeeds but post-conditions are not met (broken binary)', () => {
    const state = createFsState();
    const deps = makeDeps(state, {
      execFileSync: (cmd, args) => {
        state.execs.push({ cmd, args });
        // Deliberately do NOT write the key file, simulating a broken build.
        const outIdx = args.indexOf('--out');
        const outDir = outIdx >= 0 ? args[outIdx + 1] : '';
        state.files.set(`${outDir}/ca.pem`, { data: 'C', mode: 0o644 });
        return '';
      },
    });

    expect(() => ensurePipelockCa(deps)).toThrow(/did not produce/i);
  });
});

// ─── ensurePipelockConfig ────────────────────────────────────────────────────

describe('ensurePipelockConfig', () => {
  it('creates /etc/pipelock and writes config.yaml with mode 0o600 on first run', () => {
    const state = createFsState();
    const deps = makeDeps(state);

    ensurePipelockConfig({ KILOCLAW_PIPELOCK_ENABLED: '1' }, deps);

    expect(state.dirs.has(PIPELOCK_CONFIG_DIR)).toBe(true);
    const file = state.files.get(PIPELOCK_CONFIG_PATH);
    expect(file).toBeDefined();
    expect(file?.mode).toBe(0o600);
  });

  it('generated YAML declares the forward-proxy listen and TLS interception CA paths', () => {
    const state = createFsState();
    const deps = makeDeps(state);

    ensurePipelockConfig({}, deps);

    const yaml = state.files.get(PIPELOCK_CONFIG_PATH)?.data ?? '';
    expect(yaml).toContain('fetch_proxy:');
    expect(yaml).toContain('listen: 127.0.0.1:8888');
    expect(yaml).toContain('forward_proxy:');
    expect(yaml).toContain('enabled: true');
    expect(yaml).toContain('tls_interception:');
    expect(yaml).toContain('ca_cert: /root/.pipelock/ca.pem');
    expect(yaml).toContain('ca_key: /root/.pipelock/ca-key.pem');
  });

  it('generated YAML enables SSE streaming scanning (v2.3.0 body-scan default)', () => {
    const state = createFsState();
    const deps = makeDeps(state);

    ensurePipelockConfig({}, deps);

    const yaml = state.files.get(PIPELOCK_CONFIG_PATH)?.data ?? '';
    expect(yaml).toContain('response_scanning:');
    expect(yaml).toContain('sse_streaming:');
  });

  it('generated YAML does NOT list passthrough_domains (full body scanning from day one)', () => {
    const state = createFsState();
    const deps = makeDeps(state);

    ensurePipelockConfig({}, deps);

    const yaml = state.files.get(PIPELOCK_CONFIG_PATH)?.data ?? '';
    expect(yaml).not.toContain('passthrough_domains');
  });

  it('is idempotent: when content matches, does not rewrite but enforces mode 0o600', () => {
    const state = createFsState();
    const firstRunDeps = makeDeps(state);
    ensurePipelockConfig({}, firstRunDeps);
    const desired = state.files.get(PIPELOCK_CONFIG_PATH)?.data ?? '';

    // Simulate someone loosening the mode between reboots
    const file = state.files.get(PIPELOCK_CONFIG_PATH);
    if (file) file.mode = 0o644;

    // Fresh deps so we can track renames/writes during the idempotent path
    const secondState: FsState = {
      files: new Map(state.files),
      dirs: new Map(state.dirs),
      execs: [],
    };
    const writeSpy = vi.fn();
    const renameSpy = vi.fn();
    const deps = makeDeps(secondState, {
      writeFileSync: writeSpy,
      renameSync: renameSpy,
    });

    ensurePipelockConfig({}, deps);

    expect(writeSpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
    expect(secondState.files.get(PIPELOCK_CONFIG_PATH)?.data).toBe(desired);
    expect(secondState.files.get(PIPELOCK_CONFIG_PATH)?.mode).toBe(0o600);
  });

  it('rewrites when existing content has drifted from the managed template', () => {
    const state = createFsState();
    state.dirs.set(PIPELOCK_CONFIG_DIR, { mode: 0o755 });
    state.files.set(PIPELOCK_CONFIG_PATH, {
      data: '# someone edited this by hand\nmode: audit\n',
      mode: 0o600,
    });
    const deps = makeDeps(state);

    ensurePipelockConfig({}, deps);

    const yaml = state.files.get(PIPELOCK_CONFIG_PATH)?.data ?? '';
    expect(yaml).not.toContain('someone edited');
    expect(yaml).toContain('mode: balanced');
    expect(state.files.get(PIPELOCK_CONFIG_PATH)?.mode).toBe(0o600);
  });
});

// ─── ensurePipelockCaBundle ─────────────────────────────────────────────────

describe('ensurePipelockCaBundle', () => {
  it('writes a combined system-plus-pipelock CA bundle with mode 0o644', () => {
    const state = createFsState();
    state.files.set(SYSTEM_CA_BUNDLE, { data: 'SYSTEM CA\n', mode: 0o644 });
    state.files.set(PIPELOCK_CA_CERT, { data: 'PIPELOCK CA\n', mode: 0o644 });
    const deps = makeDeps(state);

    ensurePipelockCaBundle(deps);

    const bundle = state.files.get(PIPELOCK_CA_BUNDLE);
    expect(bundle).toEqual({
      data: 'SYSTEM CA\n\nPIPELOCK CA\n',
      mode: 0o644,
    });
  });

  it('is idempotent when the combined bundle already matches', () => {
    const state = createFsState();
    state.files.set(SYSTEM_CA_BUNDLE, { data: 'SYSTEM CA\n', mode: 0o644 });
    state.files.set(PIPELOCK_CA_CERT, { data: 'PIPELOCK CA\n', mode: 0o644 });
    state.files.set(PIPELOCK_CA_BUNDLE, {
      data: 'SYSTEM CA\n\nPIPELOCK CA\n',
      mode: 0o600,
    });
    const writeSpy = vi.fn();
    const renameSpy = vi.fn();
    const deps = makeDeps(state, {
      writeFileSync: writeSpy,
      renameSync: renameSpy,
    });

    ensurePipelockCaBundle(deps);

    expect(writeSpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
    expect(state.files.get(PIPELOCK_CA_BUNDLE)?.mode).toBe(0o644);
  });

  it('throws if the system CA bundle is unavailable', () => {
    const state = createFsState();
    state.files.set(PIPELOCK_CA_CERT, { data: 'PIPELOCK CA\n', mode: 0o644 });
    const deps = makeDeps(state);

    expect(() => ensurePipelockCaBundle(deps)).toThrow(/ENOENT/);
  });
});

// ─── waitForListening ────────────────────────────────────────────────────────

describe('waitForListening', () => {
  let server: net.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server?.close(() => resolve()));
      server = null;
    }
  });

  it('returns true quickly when the port is already listening', async () => {
    const port = await listenOnFreePort(s => (server = s));

    const start = Date.now();
    const ok = await waitForListening('127.0.0.1', port, 5_000);
    const elapsed = Date.now() - start;

    expect(ok).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  it('returns false after the deadline when every connect attempt fails', async () => {
    const fakeConnect = (_host: string, _port: number): net.Socket => {
      const sock = new net.Socket();
      queueMicrotask(() =>
        sock.emit('error', Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }))
      );
      return sock;
    };

    const start = Date.now();
    const ok = await waitForListening('127.0.0.1', 1, 300, {
      intervalMs: 50,
      connect: fakeConnect,
    });
    const elapsed = Date.now() - start;

    expect(ok).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(1500);
  });

  it('returns true after initial connection refusals when the port comes up mid-poll', async () => {
    let attempts = 0;
    const fakeConnect = (_host: string, _port: number): net.Socket => {
      attempts += 1;
      const sock = new net.Socket();
      const refuse = attempts < 3;
      queueMicrotask(() => {
        if (refuse) {
          sock.emit('error', Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        } else {
          sock.emit('connect');
        }
      });
      return sock;
    };

    const ok = await waitForListening('127.0.0.1', 1, 3_000, {
      intervalMs: 10,
      connect: fakeConnect,
    });

    expect(ok).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it('returns false instead of throwing when connect throws synchronously', async () => {
    const ok = await waitForListening('127.0.0.1', 1, 100, {
      connect: () => {
        throw new Error('bad connect');
      },
    });

    expect(ok).toBe(false);
  });
});

// ─── waitForSupervisorAlive ──────────────────────────────────────────────────

describe('waitForSupervisorAlive', () => {
  it('returns true once the supervisor reports running', async () => {
    let calls = 0;
    const fakeSupervisor = {
      getState: (): SupervisorState => {
        calls += 1;
        return calls < 3 ? 'starting' : 'running';
      },
    };

    const ok = await waitForSupervisorAlive(fakeSupervisor, 1_000, { intervalMs: 5 });

    expect(ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('returns false immediately when the supervisor is in crashed state (binary missing)', async () => {
    const fakeSupervisor = { getState: (): SupervisorState => 'crashed' };

    const ok = await waitForSupervisorAlive(fakeSupervisor, 5_000, { intervalMs: 5 });

    expect(ok).toBe(false);
  });

  it('returns false on deadline when the supervisor is stuck in starting state', async () => {
    const fakeSupervisor = { getState: (): SupervisorState => 'starting' };

    const ok = await waitForSupervisorAlive(fakeSupervisor, 80, { intervalMs: 10 });

    expect(ok).toBe(false);
  });
});

// ─── waitForPipelockReady ────────────────────────────────────────────────────

describe('waitForPipelockReady', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server?.close(() => resolve()));
      server = null;
    }
  });

  it('returns true when /health reports the expected pipelock features', async () => {
    const port = await listenOnFreeHttpPort(
      {
        status: 'healthy',
        forward_proxy_enabled: true,
        tls_interception_enabled: true,
        response_scan_enabled: true,
      },
      s => (server = s)
    );

    const ok = await waitForPipelockReady('127.0.0.1', port, 5_000);

    expect(ok).toBe(true);
  });

  it('returns false when a listener responds but is not a healthy pipelock proxy', async () => {
    const port = await listenOnFreeHttpPort({ status: 'ok' }, s => (server = s));

    const ok = await waitForPipelockReady('127.0.0.1', port, 300, { intervalMs: 50 });

    expect(ok).toBe(false);
  });

  it('returns false when /health reports a pre-activated kill switch (operationally not ready)', async () => {
    const port = await listenOnFreeHttpPort(
      {
        status: 'healthy',
        forward_proxy_enabled: true,
        tls_interception_enabled: true,
        response_scan_enabled: true,
        kill_switch_active: true,
      },
      s => (server = s)
    );

    const ok = await waitForPipelockReady('127.0.0.1', port, 300, { intervalMs: 50 });

    expect(ok).toBe(false);
  });

  it('returns true when kill_switch_active is false (explicit off)', async () => {
    const port = await listenOnFreeHttpPort(
      {
        status: 'healthy',
        forward_proxy_enabled: true,
        tls_interception_enabled: true,
        response_scan_enabled: true,
        kill_switch_active: false,
      },
      s => (server = s)
    );

    const ok = await waitForPipelockReady('127.0.0.1', port, 5_000);

    expect(ok).toBe(true);
  });

  it('polls until pipelock health becomes ready', async () => {
    let calls = 0;
    const ok = await waitForPipelockReady('127.0.0.1', 8888, 1_000, {
      intervalMs: 10,
      getHealth: async () => {
        calls += 1;
        if (calls < 3) return null;
        return {
          status: 'healthy',
          forward_proxy_enabled: true,
          tls_interception_enabled: true,
          response_scan_enabled: true,
        };
      },
    });

    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function listenOnFreePort(register: (s: net.Server) => void): Promise<number> {
  return await new Promise<number>(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      register(s);
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
        return;
      }
      throw new Error('server did not expose a port');
    });
  });
}

async function listenOnFreeHttpPort(
  responseBody: Record<string, unknown>,
  register: (s: http.Server) => void
): Promise<number> {
  return await new Promise<number>(resolve => {
    const s = http.createServer((req, res) => {
      if (req.url !== '/health') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(responseBody));
    });
    s.listen(0, '127.0.0.1', () => {
      register(s);
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
        return;
      }
      throw new Error('server did not expose a port');
    });
  });
}
