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
    ['missing fence', { request: validRequest() }],
    ['missing request', { fence: validFence() }],
    [
      'wrong-shape fence',
      { fence: { runtimeId: 'not-a-uuid', connectionId: 'cli-1' }, request: validRequest() },
    ],
    ['wrong-shape request', { fence: validFence(), request: { protocolVersion: 2 } }],
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
    ['RUNTIME_FENCE_MISMATCH', 409, 'Runtime control request rejected'],
    ['CATALOG_CHANGED', 409, 'Catalog request rejected'],
    ['COMMAND_ALREADY_PENDING', 409, 'Runtime control request rejected'],
  ])('maps %s to 409 with safe envelope', async (code, status, message) => {
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
        message,
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
        message: 'Runtime control request expired',
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

  it.each(['RESULT_TOO_LARGE', 'INVALID_RUNTIME_RESPONSE', 'RUNTIME_COMMAND_FAILED'])(
    'maps %s to 500 with safe envelope',
    async code => {
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
    }
  );

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
    expect(body).toEqual({
      error: { source: 'relay', code: 'INTERNAL', message: 'Internal error' },
    });
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

describe('POST /internal/runtime-control/create-and-run', () => {
  function validCreateAndRunRequest() {
    return {
      protocolVersion: 1,
      requestId: '0c0a1b2c-3d4e-4f60-8a8b-9c0d1e2f3a4b',
      prompt: 'hello',
      model: { providerID: 'kilo', modelID: 'kilo/auto' },
      agent: 'build',
    };
  }

  function validCreateAndRunResult() {
    return {
      protocolVersion: 1,
      sessionId: 'ses_a1b2c3d4e5f67890123456789a',
      promptStarted: true,
    };
  }

  function makeDoStub(
    overrides: Partial<{ createAndRunLocalSession: ReturnType<typeof vi.fn> }> = {}
  ) {
    return {
      createAndRunLocalSession: overrides.createAndRunLocalSession ?? vi.fn(async () => undefined),
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('accepts the exact body, calls the user DO once, and returns the strict {result} envelope', async () => {
    const result = validCreateAndRunResult();
    const createAndRunLocalSession = vi.fn(async () => result);
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const fence = validFence();
    const request = validCreateAndRunRequest();
    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence, request }),
      }),
      {}
    );

    expect(res.status).toBe(200);
    expect(createAndRunLocalSession).toHaveBeenCalledTimes(1);
    expect(createAndRunLocalSession).toHaveBeenCalledWith(fence, request);
    expect(await res.json()).toEqual({ result });
  });

  it('forwards the fence and request unchanged to the DO', async () => {
    const createAndRunLocalSession = vi.fn(async () => validCreateAndRunResult());
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const fence = {
      runtimeId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      connectionId: 'cli-77',
    };
    const request = { ...validCreateAndRunRequest(), variant: 'thinking' };
    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence, request }),
      }),
      {}
    );

    expect(res.status).toBe(200);
    expect(createAndRunLocalSession).toHaveBeenCalledWith(fence, request);
  });

  it.each([
    ['GET', undefined],
    ['PUT', JSON.stringify({ fence: validFence(), request: validCreateAndRunRequest() })],
    ['PATCH', JSON.stringify({ fence: validFence(), request: validCreateAndRunRequest() })],
    ['DELETE', undefined],
  ])('returns 404 for %s on the create-and-run path', async (method, body) => {
    const app = makeApp();
    const init: RequestInit = { method };
    if (body) {
      init.headers = { 'content-type': 'application/json' };
      init.body = body;
    }
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', init),
      {}
    );
    expect(res.status).toBe(404);
  });

  it('rejects Content-Length > 64 KiB with 413 before parsing', async () => {
    const createAndRunLocalSession = vi.fn();
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const app = makeApp();
    const oversized = 'x'.repeat(64 * 1024 + 1);
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
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
    expect(createAndRunLocalSession).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['extra fields', { fence: validFence(), request: validCreateAndRunRequest(), extra: true }],
    ['missing fence', { request: validCreateAndRunRequest() }],
    ['missing request', { fence: validFence() }],
    [
      'wrong-shape fence',
      {
        fence: { runtimeId: 'not-a-uuid', connectionId: 'cli-1' },
        request: validCreateAndRunRequest(),
      },
    ],
    [
      'wrong-shape request',
      { fence: validFence(), request: { ...validCreateAndRunRequest(), prompt: '' } },
    ],
  ])('rejects %s with 400', async (_label, body) => {
    const createAndRunLocalSession = vi.fn();
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      {}
    );

    expect(res.status).toBe(400);
    expect(createAndRunLocalSession).not.toHaveBeenCalled();
  });

  it('maps RUNTIME_NOT_CONNECTED to 404 with safe envelope', async () => {
    const createAndRunLocalSession = vi.fn(async () => {
      throw Object.assign(new Error('Runtime is not currently connected'), {
        code: 'RUNTIME_NOT_CONNECTED',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validCreateAndRunRequest() }),
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

  it('maps RUNTIME_FENCE_MISMATCH to 409 with safe envelope', async () => {
    const createAndRunLocalSession = vi.fn(async () => {
      throw Object.assign(new Error('relay: RUNTIME_FENCE_MISMATCH'), {
        code: 'RUNTIME_FENCE_MISMATCH',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validCreateAndRunRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        source: 'relay',
        code: 'RUNTIME_FENCE_MISMATCH',
        message: 'Runtime control request rejected',
      },
    });
  });

  it('maps COMMAND_EXPIRED to 504 with safe envelope', async () => {
    const createAndRunLocalSession = vi.fn(async () => {
      throw Object.assign(new Error('expired'), {
        code: 'COMMAND_EXPIRED',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validCreateAndRunRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: {
        source: 'relay',
        code: 'COMMAND_EXPIRED',
        message: 'Runtime control request expired',
      },
    });
  });

  it('maps CLI_UPGRADE_REQUIRED to 412 with safe envelope', async () => {
    const createAndRunLocalSession = vi.fn(async () => {
      throw Object.assign(new Error('CLI too old'), {
        code: 'CLI_UPGRADE_REQUIRED',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validCreateAndRunRequest() }),
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

  it('maps RESULT_TOO_LARGE to 500 with safe envelope and no message leak', async () => {
    const createAndRunLocalSession = vi.fn(async () => {
      throw Object.assign(new Error('super-secret-do-leak-marker-for-too-large'), {
        code: 'RESULT_TOO_LARGE',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validCreateAndRunRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        source: 'relay',
        code: 'RESULT_TOO_LARGE',
        message: 'Internal error',
      },
    });
    expect(JSON.stringify(body)).not.toContain('super-secret-do-leak-marker');
  });

  it('returns 500 with safe envelope on a thrown non-typed error', async () => {
    const createAndRunLocalSession = vi.fn(async () => {
      throw new Error('super-secret-do-internal-leak-marker');
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validCreateAndRunRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: { source: 'relay', code: 'INTERNAL', message: 'Internal error' },
    });
    expect(JSON.stringify(body)).not.toContain('super-secret-do-internal-leak-marker');
  });

  it('returns the promptStarted:false partial result when the DO resolves with it', async () => {
    const partialResult = {
      protocolVersion: 1,
      sessionId: 'ses_b2c3d4e5f67890123456789cde',
      promptStarted: false,
      error: {
        code: 'PROMPT_START_FAILED',
        message: 'The session was created, but the first prompt did not start.',
      },
    };
    const createAndRunLocalSession = vi.fn(async () => partialResult);
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const app = makeApp();
    const res = await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validCreateAndRunRequest() }),
      }),
      {}
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: partialResult });
  });

  it('does not log the token, the body, or the raw DO error on failure', async () => {
    const createAndRunLocalSession = vi.fn(async () => {
      throw Object.assign(new Error('super-secret-do-leak-marker'), {
        code: 'RUNTIME_COMMAND_FAILED',
        name: 'LocalRuntimeCommandError',
      });
    });
    vi.mocked(getUserConnectionDO).mockReturnValue(
      makeDoStub({ createAndRunLocalSession }) as never
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const app = makeApp();
    await app.fetch(
      new Request('http://local/internal/runtime-control/create-and-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fence: validFence(), request: validCreateAndRunRequest() }),
      }),
      {}
    );

    const dumped = JSON.stringify({ warns: warn.mock.calls, errors: error.mock.calls });
    expect(dumped).not.toContain('super-secret-do-leak-marker');
    expect(dumped).not.toContain(JSON.stringify(validFence()));
  });
});
