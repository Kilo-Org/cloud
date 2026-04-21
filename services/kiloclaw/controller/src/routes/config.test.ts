import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { registerConfigRoutes } from './config';
import type { Supervisor } from '../supervisor';

vi.mock('../config-writer', () => ({
  backupConfigFile: vi.fn(),
  writeBaseConfig: vi.fn(),
}));

vi.mock('../atomic-write', () => ({
  atomicWrite: vi.fn(),
}));

// Mock fs at the module level (for config/patch tests — readFileSync is still used directly)
vi.mock('node:fs', () => {
  return {
    default: {
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(),
    },
  };
});

import { backupConfigFile, writeBaseConfig } from '../config-writer';
import { atomicWrite } from '../atomic-write';
import fs from 'node:fs';

const readMock = vi.mocked(fs.readFileSync);
const writeMock = vi.mocked(fs.writeFileSync);
const existsMock = vi.mocked(fs.existsSync);
const atomicWriteMock = vi.mocked(atomicWrite);
const backupMock = vi.mocked(backupConfigFile);

function createMockSupervisor(): Supervisor {
  const state = 'running' as const;
  return {
    start: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    restart: vi.fn(async () => true),
    shutdown: vi.fn(async () => undefined),
    signal: vi.fn(() => true),
    getState: vi.fn(() => state),
    getStats: vi.fn(() => ({
      state,
      pid: 100,
      uptime: 50,
      restarts: 3,
      lastExit: null,
    })),
  };
}

function authHeaders(token = 'test-token'): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('/_kilo/config/restore routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects requests without auth', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerConfigRoutes(app, supervisor, 'test-token');

    const resp = await app.request('/_kilo/config/restore/base', { method: 'POST' });
    expect(resp.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerConfigRoutes(app, supervisor, 'test-token');

    const resp = await app.request('/_kilo/config/restore/base', {
      method: 'POST',
      headers: authHeaders('wrong-token'),
    });
    expect(resp.status).toBe(401);
  });

  it('rejects invalid version', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerConfigRoutes(app, supervisor, 'test-token');

    const resp = await app.request('/_kilo/config/restore/unknown', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain('Invalid config version');
  });

  it('restores base config, signals SIGUSR1, and returns ok', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerConfigRoutes(app, supervisor, 'test-token');

    const resp = await app.request('/_kilo/config/restore/base', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, signaled: true });

    expect(writeBaseConfig).toHaveBeenCalledWith(process.env);
    expect(supervisor.signal).toHaveBeenCalledWith('SIGUSR1');
  });

  it('returns 500 when config write fails', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerConfigRoutes(app, supervisor, 'test-token');

    vi.mocked(writeBaseConfig).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const resp = await app.request('/_kilo/config/restore/base', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain('disk full');
  });

  it('restores config but does not signal when gateway is not running', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    vi.mocked(supervisor.getState).mockReturnValue('stopped');
    registerConfigRoutes(app, supervisor, 'test-token');

    const resp = await app.request('/_kilo/config/restore/base', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, signaled: false });

    expect(writeBaseConfig).toHaveBeenCalledWith(process.env);
    expect(supervisor.signal).not.toHaveBeenCalled();
  });

  it('does not leak through to catch-all proxy', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerConfigRoutes(app, supervisor, 'test-token');
    app.all('*', c => c.json({ proxied: true }));

    const resp = await app.request('/_kilo/config/restore/base');
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: 'Unauthorized' });
  });
});

describe('/_kilo/config/patch routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    existsMock.mockReturnValue(true);
  });

  it('enforces bearer auth', async () => {
    const app = new Hono();
    registerConfigRoutes(app, createMockSupervisor(), 'test-token');

    const noAuth = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: JSON.stringify({ foo: 'bar' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(noAuth.status).toBe(401);

    const wrongAuth = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: JSON.stringify({ foo: 'bar' }),
      headers: authHeaders('bad-token'),
    });
    expect(wrongAuth.status).toBe(401);
  });

  it('deep-merges patch into existing config', async () => {
    const app = new Hono();
    registerConfigRoutes(app, createMockSupervisor(), 'test-token');

    const existingConfig = {
      agents: { defaults: { model: { primary: 'kilocode/anthropic/claude-opus-4.6' } } },
      gateway: { port: 3001 },
    };
    readMock.mockReturnValue(JSON.stringify(existingConfig));

    const resp = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: JSON.stringify({
        agents: { defaults: { model: { primary: 'kilocode/anthropic/claude-sonnet-4.5' } } },
      }),
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    expect(atomicWriteMock).toHaveBeenCalledOnce();
    // First arg should be the config path, second the serialized JSON
    expect(atomicWriteMock.mock.calls[0][0]).toBe('/root/.openclaw/openclaw.json');
    const written = JSON.parse(atomicWriteMock.mock.calls[0][1] as string);
    expect(written.agents.defaults.model.primary).toBe('kilocode/anthropic/claude-sonnet-4.5');
    // Existing keys preserved
    expect(written.gateway.port).toBe(3001);
  });

  it('rejects non-object body', async () => {
    const app = new Hono();
    registerConfigRoutes(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: JSON.stringify([1, 2, 3]),
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const app = new Hono();
    registerConfigRoutes(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: 'not json',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(400);
  });

  it('rejects prototype pollution keys', async () => {
    const app = new Hono();
    registerConfigRoutes(app, createMockSupervisor(), 'test-token');

    const existingConfig = { safe: 'value' };
    readMock.mockReturnValue(JSON.stringify(existingConfig));

    const resp = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: JSON.stringify({
        __proto__: { polluted: true },
        constructor: { polluted: true },
        prototype: { polluted: true },
        nested: { __proto__: { deep: true } },
        legit: 'ok',
      }),
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    expect(atomicWriteMock).toHaveBeenCalledOnce();
    const written = JSON.parse(atomicWriteMock.mock.calls[0][1] as string);
    // Banned keys are silently dropped at every depth
    expect(Object.hasOwn(written, '__proto__')).toBe(false);
    expect(Object.hasOwn(written, 'constructor')).toBe(false);
    expect(Object.hasOwn(written, 'prototype')).toBe(false);
    expect(Object.hasOwn(written.nested ?? {}, '__proto__')).toBe(false);
    // Legit keys are preserved
    expect(written.legit).toBe('ok');
    expect(written.safe).toBe('value');
  });

  it('returns 500 when config file is missing', async () => {
    const app = new Hono();
    registerConfigRoutes(app, createMockSupervisor(), 'test-token');

    readMock.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });

    const resp = await app.request('/_kilo/config/patch', {
      method: 'POST',
      body: JSON.stringify({ agents: {} }),
      headers: authHeaders(),
    });
    expect(resp.status).toBe(500);
  });
});

describe('/_kilo/config/tools-md/google-workspace route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    existsMock.mockReturnValue(true);
    readMock.mockReturnValue('# TOOLS\n');
  });

  it('enforces bearer auth', async () => {
    const app = new Hono();
    registerConfigRoutes(app, createMockSupervisor(), 'test-token');

    const noAuth = await app.request('/_kilo/config/tools-md/google-workspace', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(noAuth.status).toBe(401);

    const wrongAuth = await app.request('/_kilo/config/tools-md/google-workspace', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
      headers: authHeaders('bad-token'),
    });
    expect(wrongAuth.status).toBe(401);
  });

  it('adds Google Workspace section when enabled=true', async () => {
    const app = new Hono();
    registerConfigRoutes(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/config/tools-md/google-workspace', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ enabled: true }),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, enabled: true });
    expect(writeMock).toHaveBeenCalledOnce();
    const written = writeMock.mock.calls[0][1] as string;
    expect(written).toContain('<!-- BEGIN:google-workspace -->');
  });

  it('removes Google Workspace section when enabled=false', async () => {
    const app = new Hono();
    registerConfigRoutes(app, createMockSupervisor(), 'test-token');

    readMock.mockReturnValue(
      `# TOOLS\n\n<!-- BEGIN:google-workspace -->\nfoo\n<!-- END:google-workspace -->\n`
    );

    const resp = await app.request('/_kilo/config/tools-md/google-workspace', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ enabled: false }),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, enabled: false });
    expect(writeMock).toHaveBeenCalledOnce();
    const written = writeMock.mock.calls[0][1] as string;
    expect(written).not.toContain('BEGIN:google-workspace');
  });
});

type TestCase = {
  route: string;
  method?: string;
  headers?: HeadersInit;
  body?: string;
  read?: () => string;
  write?: () => void;
  expect: {
    status: number;
    body?: unknown;
    bodyContains?: Record<string, unknown>;
    mocks?: {
      backup?: (mock: typeof backupMock) => void;
      write?: (mock: typeof atomicWriteMock) => void;
    };
  };
};

async function test(tc: TestCase) {
  const app = new Hono();
  registerConfigRoutes(app, createMockSupervisor(), 'test-token');

  if (tc.read) {
    readMock.mockImplementation(tc.read);
  }

  if (tc.write) {
    atomicWriteMock.mockImplementation(tc.write);
  }

  const resp = await app.request(tc.route, {
    method: tc.method ?? 'GET',
    headers: tc.headers,
    body: tc.body,
  });

  expect(resp.status).toBe(tc.expect.status);

  const json =
    tc.expect.body !== undefined || tc.expect.bodyContains !== undefined
      ? await resp.json()
      : undefined;

  if (tc.expect.body !== undefined) {
    expect(json).toEqual(tc.expect.body);
  }

  if (tc.expect.bodyContains !== undefined) {
    expect(json).toMatchObject(tc.expect.bodyContains);
  }

  if (tc.expect.mocks?.write) {
    tc.expect.mocks.write(atomicWriteMock);
  }

  if (tc.expect.mocks?.backup) {
    tc.expect.mocks.backup(backupMock);
  }
}

describe('/_kilo/config/read routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects requests without auth', async () => {
    await test({
      route: '/_kilo/config/read',
      expect: {
        status: 401,
      },
    });
  });

  it('rejects requests with wrong token', async () => {
    await test({
      route: '/_kilo/config/read',
      headers: {
        Authorization: 'Bearer wrong-token',
      },
      expect: {
        status: 401,
      },
    });
  });

  it('returns the parsed config with etag', async () => {
    const config = {
      gateway: { port: 3001 },
      agents: { defaults: { model: { primary: 'test' } } },
    };
    const raw = JSON.stringify(config);

    await test({
      route: '/_kilo/config/read',
      headers: { Authorization: 'Bearer test-token' },
      read: () => raw,
      expect: {
        status: 200,
        // Hardcoded real hash of above config, to avoid exposing or
        // duplicating the private hash calculation function
        body: { config, etag: 'ba2c2548ac3dbe82044f0276f9e9e03b' },
      },
    });
  });

  it('returns 500 when config file contains non-object JSON', async () => {
    await test({
      route: '/_kilo/config/read',
      headers: { Authorization: 'Bearer test-token' },
      read: () => '[1, 2, 3]',
      expect: {
        status: 500,
        bodyContains: {
          code: 'config_read_failed',
          error: 'Config file does not contain a JSON object',
        },
      },
    });
  });

  it('returns 500 when config file is missing', async () => {
    await test({
      route: '/_kilo/config/read',
      headers: { Authorization: 'Bearer test-token' },
      read: () => {
        throw new Error('ENOENT: no such file');
      },
      expect: {
        status: 500,
        bodyContains: {
          error: expect.stringContaining('Failed to read config'),
        },
      },
    });
  });
});

describe('/_kilo/config/replace routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects requests without auth', async () => {
    await test({
      route: '/_kilo/config/replace',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: { gateway: {} },
      }),
      expect: {
        status: 401,
      },
    });
  });

  it('rejects requests with wrong token', async () => {
    await test({
      route: '/_kilo/config/replace',
      method: 'POST',
      headers: authHeaders('bad-token'),
      body: JSON.stringify({
        config: { gateway: {} },
      }),
      expect: {
        status: 401,
      },
    });
  });

  it('replaces config file entirely', async () => {
    const newConfig = { agents: { custom: true }, gateway: { port: 9999 } };

    await test({
      route: '/_kilo/config/replace',
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ config: newConfig }),
      expect: {
        status: 200,
        body: { ok: true },
        mocks: {
          backup: mock => {
            expect(mock).toHaveBeenCalledOnce();
            expect(mock).toHaveBeenCalledWith('/root/.openclaw/openclaw.json');
          },
          write: mock => {
            expect(mock).toHaveBeenCalledOnce();
            const written = JSON.parse(mock.mock.calls[0][1] as string);
            expect(written).toEqual(newConfig);
          },
        },
      },
    });
  });

  it('replaces config when etag matches', async () => {
    const existing = JSON.stringify({ old: true }, null, 2);
    const newConfig = { agents: { custom: true } };
    // md5('{\n  "old": true\n}')
    const etag = 'd9e2d0820f656cdfc4e3a872523a92a8';

    await test({
      route: '/_kilo/config/replace',
      method: 'POST',
      headers: authHeaders(),
      read: () => existing,
      body: JSON.stringify({ config: newConfig, etag }),
      expect: {
        status: 200,
        body: { ok: true },
        mocks: {
          backup: mock => {
            expect(mock).toHaveBeenCalledOnce();
            expect(mock).toHaveBeenCalledWith('/root/.openclaw/openclaw.json');
          },
          write: mock => {
            expect(mock).toHaveBeenCalledOnce();
            const written = JSON.parse(mock.mock.calls[0][1] as string);
            expect(written).toEqual(newConfig);
          },
        },
      },
    });
  });

  it('rejects replace when etag does not match', async () => {
    const existing = JSON.stringify({ old: true }, null, 2);

    await test({
      route: '/_kilo/config/replace',
      method: 'POST',
      headers: authHeaders(),
      read: () => existing,
      body: JSON.stringify({ config: { new: true }, etag: 'stale-etag' }),
      expect: {
        status: 409,
        bodyContains: { error: expect.stringContaining('Config was modified') },
        mocks: {
          backup: mock => {
            expect(mock).not.toHaveBeenCalled();
          },
          write: mock => {
            expect(mock).not.toHaveBeenCalled();
          },
        },
      },
    });
  });

  it('skips etag check when etag is not provided', async () => {
    const newConfig = { gateway: { port: 1234 } };

    await test({
      route: '/_kilo/config/replace',
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ config: newConfig }),
      expect: {
        status: 200,
        body: { ok: true },
        mocks: {
          backup: mock => {
            expect(mock).toHaveBeenCalledOnce();
            expect(mock).toHaveBeenCalledWith('/root/.openclaw/openclaw.json');
          },
          write: mock => {
            expect(mock).toHaveBeenCalledOnce();
          },
        },
      },
    });
  });

  it('rejects non-object body', async () => {
    await test({
      route: '/_kilo/config/replace',
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify([1, 2, 3]),
      expect: {
        status: 400,
      },
    });
  });

  it('rejects body without config field', async () => {
    await test({
      route: '/_kilo/config/replace',
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ gateway: {} }),
      expect: {
        status: 400,
      },
    });
  });

  it('rejects invalid JSON', async () => {
    await test({
      route: '/_kilo/config/replace',
      method: 'POST',
      headers: authHeaders(),
      body: 'not json',
      expect: {
        status: 400,
      },
    });
  });

  it('returns 500 when write fails', async () => {
    await test({
      route: '/_kilo/config/replace',
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        config: { gateway: {} },
      }),
      write: () => {
        throw new Error('');
      },
      expect: {
        status: 500,
        bodyContains: { error: expect.stringContaining('Failed to replace config') },
        mocks: {
          backup: mock => {
            expect(mock).toHaveBeenCalledOnce();
            expect(mock).toHaveBeenCalledWith('/root/.openclaw/openclaw.json');
          },
        },
      },
    });
  });

  it('returns 500 when backup fails', async () => {
    backupMock.mockImplementation(() => {
      throw new Error('backup failed');
    });

    await test({
      route: '/_kilo/config/replace',
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        config: { gateway: {} },
      }),
      expect: {
        status: 500,
        bodyContains: { error: expect.stringContaining('Failed to replace config') },
        mocks: {
          backup: mock => {
            expect(mock).toHaveBeenCalledOnce();
          },
          write: mock => {
            expect(mock).not.toHaveBeenCalled();
          },
        },
      },
    });
  });
});
