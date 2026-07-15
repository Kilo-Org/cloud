import { Hono } from 'hono';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { runtimeControlApi } from './runtime-control';

vi.mock('../dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(),
}));

import { getUserConnectionDO } from '../dos/UserConnectionDO';

type ApiContext = {
  Bindings: Record<string, unknown>;
  Variables: { user_id: string };
};

function makeApp() {
  const app = new Hono<ApiContext>();
  app.use('*', async (c, next) => {
    c.set('user_id', 'usr_test');
    await next();
  });
  app.route('/internal/runtime-control', runtimeControlApi);
  return app;
}

function validFence() {
  return {
    runtimeId: '8db3de9a-350f-4fad-a539-8e0da3bbcf5e',
    connectionId: 'cli-1',
  };
}

function validRequest() {
  return { protocolVersion: 1 };
}

function validCatalogBody() {
  return {
    catalog: {
      protocolVersion: 1,
      models: {},
      agents: [{ slug: 'build', name: 'Build' }],
      defaultAgent: 'build',
    },
  };
}

function makeDoStub(overrides: Partial<{ getRuntimeCatalog: ReturnType<typeof vi.fn> }> = {}) {
  return {
    getRuntimeCatalog: overrides.getRuntimeCatalog ?? vi.fn(async () => undefined),
  };
}

describe('POST /internal/runtime-control/catalog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('accepts the exact body, calls the user DO, and returns the strict envelope', async () => {
    const catalog = validCatalogBody().catalog;
    const getRuntimeCatalog = vi.fn(async () => catalog);
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(200);
    expect(getUserConnectionDO).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: 'usr_test',
    });
    expect(getRuntimeCatalog).toHaveBeenCalledWith(validFence());
    expect(await res.json()).toEqual(validCatalogBody());
  });

  it('passes the fence through to the DO unchanged', async () => {
    const getRuntimeCatalog = vi.fn(async () => validCatalogBody().catalog);
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const fence = {
      runtimeId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      connectionId: 'cli-77',
    };
    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence, request: validRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(200);
    expect(getRuntimeCatalog).toHaveBeenCalledWith(fence);
  });

  it.each([
    ['GET', undefined],
    ['PUT', JSON.stringify({ fence: validFence(), request: validRequest() })],
    ['PATCH', JSON.stringify({ fence: validFence(), request: validRequest() })],
    ['DELETE', undefined],
  ])('returns 404 for %s on the catalog path', async (method, body) => {
    const app = makeApp();
    const init: RequestInit = { method };
    if (body) {
      init.headers = { 'content-type': 'application/json' };
      init.body = body;
    }
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', init),
      {}
    );
    expect(res.status).toBe(404);
  });

  it('rejects Content-Length > 64 KiB with 413 before parsing', async () => {
    const getRuntimeCatalog = vi.fn();
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const app = makeApp();
    const oversized = 'x'.repeat(64 * 1024 + 1);
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(oversized.length),
        },
        body: oversized,
      }),
      {}
    );

    expect(res.status).toBe(413);
    expect(getRuntimeCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['extra fields', { fence: validFence(), request: validRequest(), extra: true }],
    [
      'missing fence',
      { request: validRequest() },
    ],
    [
      'missing request',
      { fence: validFence() },
    ],
    ['wrong-shape fence', { fence: { runtimeId: 'not-a-uuid', connectionId: 'cli-1' }, request: validRequest() }],
    [
      'wrong-shape request',
      { fence: validFence(), request: { protocolVersion: 2 } },
    ],
  ])('rejects %s with 400', async (_label, body) => {
    const getRuntimeCatalog = vi.fn();
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      {}
    );

    expect(res.status).toBe(400);
    expect(getRuntimeCatalog).not.toHaveBeenCalled();
  });

  it('maps RUNTIME_NOT_CONNECTED to 404 with safe envelope', async () => {
    const getRuntimeCatalog = vi.fn(async () => {
      throw Object.assign(new Error('Runtime is not currently connected'), {
        code: 'RUNTIME_NOT_CONNECTED',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        source: 'relay',
        code: 'RUNTIME_NOT_CONNECTED',
        message: 'Runtime is not currently connected',
      },
    });
  });

  it.each([
    ['RUNTIME_FENCE_MISMATCH', 409],
    ['CATALOG_CHANGED', 409],
    ['COMMAND_ALREADY_PENDING', 409],
  ])('maps %s to 409 with safe envelope', async (code, status) => {
    const getRuntimeCatalog = vi.fn(async () => {
      throw Object.assign(new Error(`relay: ${code}`), { code, name: 'LocalRuntimeCommandError' });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({
      error: {
        source: 'relay',
        code,
        message: 'Catalog request rejected',
      },
    });
  });

  it('maps CLI_UPGRADE_REQUIRED to 412 with safe envelope', async () => {
    const getRuntimeCatalog = vi.fn(async () => {
      throw Object.assign(new Error('CLI too old'), {
        code: 'CLI_UPGRADE_REQUIRED',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({
      error: {
        source: 'relay',
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'CLI upgrade required',
      },
    });
  });

  it('maps COMMAND_EXPIRED to 504 with safe envelope', async () => {
    const getRuntimeCatalog = vi.fn(async () => {
      throw Object.assign(new Error('expired'), {
        code: 'COMMAND_EXPIRED',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: {
        source: 'relay',
        code: 'COMMAND_EXPIRED',
        message: 'Catalog request expired',
      },
    });
  });

  it('maps PENDING_COMMAND_LIMIT to 429 with safe envelope', async () => {
    const getRuntimeCatalog = vi.fn(async () => {
      throw Object.assign(new Error('limit'), {
        code: 'PENDING_COMMAND_LIMIT',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: {
        source: 'relay',
        code: 'PENDING_COMMAND_LIMIT',
        message: 'Too many pending commands',
      },
    });
  });

  it('maps COMMAND_NOT_ALLOWED to 403 with safe envelope', async () => {
    const getRuntimeCatalog = vi.fn(async () => {
      throw Object.assign(new Error('nope'), {
        code: 'COMMAND_NOT_ALLOWED',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        source: 'relay',
        code: 'COMMAND_NOT_ALLOWED',
        message: 'Command not allowed',
      },
    });
  });

  it.each([
    'RESULT_TOO_LARGE',
    'INVALID_RUNTIME_RESPONSE',
    'RUNTIME_COMMAND_FAILED',
  ])('maps %s to 500 with safe envelope', async code => {
    const getRuntimeCatalog = vi.fn(async () => {
      throw Object.assign(new Error(`secret-do-message-for-${code}-leak-marker`), {
        code,
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        source: 'relay',
        code,
        message: 'Internal error',
      },
    });
    // No leak of the original error message
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain('secret-do-message-for-');
    expect(dumped).not.toContain('leak-marker');
  });

  it('returns 500 with safe envelope on a thrown non-typed error', async () => {
    const getRuntimeCatalog = vi.fn(async () => {
      throw new Error('super-secret-do-internal-leak-marker');
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: { source: 'relay', code: 'INTERNAL', message: 'Internal error' } });
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain('super-secret-do-internal-leak-marker');
  });

  it('does not log the token, the body, or the raw catalog content on failure', async () => {
    const getRuntimeCatalog = vi.fn(async () => {
      throw Object.assign(new Error('super-secret-do-leak-marker'), {
        code: 'RUNTIME_COMMAND_FAILED',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(makeDoStub({ getRuntimeCatalog }) as never);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const app = makeApp();
    await app.fetch(
      new Request('http://local/internal/runtime-control/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validRequest() }),
      }),
      {}
    );

    const dumped = JSON.stringify({ warns: warn.mock.calls, errors: error.mock.calls });
    expect(dumped).not.toContain('super-secret-do-leak-marker');
    expect(dumped).not.toContain(JSON.stringify(validFence()));
  });
});
