import { describe, expect, it, vi } from 'vitest';
import {
  TOKEN_REQUEST_MAX_BYTES,
  createRefreshReuseHandler,
  readTokenBody,
  rememberIssuedRefreshToken,
  type RefreshReuseStore,
} from './refresh-reuse';

const FORM = 'application/x-www-form-urlencoded';
const TOKEN_URL = 'https://kilo-mcp.test/token';

/** A request whose body arrives as a stream. */
function streamedRequest(
  stream: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {}
): Request {
  return new Request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': FORM, ...headers },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

function formRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': FORM, ...headers },
    body,
  });
}

/** `count` chunks of filler, then no further pull. */
function endlessChunks(count: number, size: number): ReadableStream<Uint8Array> {
  let pulled = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= count) return new Promise<void>(() => {});
      pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
}

/** `Promise.withResolvers`, absent from this service's ES2022 lib. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

function makeDeps() {
  const store: RefreshReuseStore = {
    getRefreshToken: async () => null,
    rememberRefreshToken: async () => {},
    forgetRefreshTokens: async () => {},
  };
  return { store, revokeGrant: vi.fn(async () => {}) };
}

function makeRevokingDeps() {
  const tokens = new Map<string, { userId: string; grantId: string; current: boolean }>();
  const store: RefreshReuseStore = {
    getRefreshToken: async hash => tokens.get(hash) ?? null,
    rememberRefreshToken: async (hash, parts) => {
      for (const entry of tokens.values()) entry.current = false;
      tokens.set(hash, { ...parts, current: true });
    },
    forgetRefreshTokens: async ({ userId, grantId }) => {
      for (const [hash, entry] of tokens) {
        if (entry.userId === userId && entry.grantId === grantId) tokens.delete(hash);
      }
    },
  };
  return { store, revokeGrant: vi.fn(async () => {}) };
}

describe('readTokenBody', () => {
  it('enforces the size limit from a declared length', async () => {
    const request = streamedRequest(endlessChunks(1, 4096), {
      'Content-Length': String(TOKEN_REQUEST_MAX_BYTES + 1),
    });
    expect(await readTokenBody(request)).toEqual({ kind: 'too_large' });
  });

  it('enforces the size limit while reading the body', async () => {
    const request = streamedRequest(endlessChunks(5, 4096));
    expect(await readTokenBody(request)).toEqual({ kind: 'too_large' });
  });

  it('accepts a form body within the limit', async () => {
    const prefix = 'grant_type=refresh_token&refresh_token=u:g:x&pad=';
    const atBound = prefix + 'a'.repeat(TOKEN_REQUEST_MAX_BYTES - prefix.length);
    expect(atBound.length).toBe(TOKEN_REQUEST_MAX_BYTES);
    expect(await readTokenBody(formRequest(atBound))).toEqual({
      kind: 'form',
      params: expect.any(URLSearchParams),
      body: expect.any(Uint8Array),
    });
    expect(await readTokenBody(formRequest(`${atBound}a`))).toEqual({ kind: 'too_large' });
  });

  it('bounds another media type and keeps its bytes', async () => {
    const payload = '{"grant_type":"refresh_token"}';
    const kept = await readTokenBody(
      new Request(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
    );
    expect(kept.kind).toBe('other');
    expect(new TextDecoder().decode(kept.kind === 'other' ? kept.body : new Uint8Array())).toBe(
      payload
    );
    expect(
      await readTokenBody(
        streamedRequest(endlessChunks(5, 4096), { 'Content-Type': 'application/json' })
      )
    ).toEqual({ kind: 'too_large' });
  });
});

describe('createRefreshReuseHandler (body reading)', () => {
  it('answers 413 for an over-limit request', async () => {
    const deps = makeDeps();
    const handle = createRefreshReuseHandler(deps);
    const queued = deferred();
    const inFlight = handle(
      formRequest('grant_type=refresh_token&refresh_token=u:g:current'),
      async () => {
        await queued.promise;
        return Response.json({ refresh_token: 'u:g:next' });
      }
    );
    const forward = vi.fn(async () => Response.json({ refresh_token: 'u:g:never' }));
    const oversized = await handle(
      streamedRequest(endlessChunks(1, 4096), {
        'Content-Length': String(TOKEN_REQUEST_MAX_BYTES + 1),
      }),
      forward
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: 'invalid_request',
      error_description: `Request body must be at most ${TOKEN_REQUEST_MAX_BYTES} bytes.`,
    });
    expect(oversized.headers.get('Cache-Control')).toBe('no-store');
    expect(forward).not.toHaveBeenCalled();
    queued.resolve();
    expect((await inFlight).status).toBe(200);
  });

  it('answers two token requests concurrently', async () => {
    const deps = makeDeps();
    const handle = createRefreshReuseHandler(deps);
    const arriving = deferred();
    const slow = handle(
      streamedRequest(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await arriving.promise;
            controller.enqueue(new TextEncoder().encode('grant_type=refresh_token'));
            controller.close();
          },
        })
      ),
      async () => Response.json({ refresh_token: 'u:g:slow' })
    );
    const other = await handle(
      formRequest('grant_type=refresh_token&refresh_token=u:g:other'),
      async () => Response.json({ refresh_token: 'u:g:other-next' })
    );
    expect(other.status).toBe(200);
    arriving.resolve();
    expect((await slow).status).toBe(200);
  });

  it('forwards the body it read, unchanged', async () => {
    const deps = makeDeps();
    const body =
      'grant_type=authorization_code&code=code&resource=https%3A%2F%2Fa&resource=https%3A%2F%2Fb';
    const forwarded = vi.fn(async (request: Request) => Response.json({ href: request.url }));
    await createRefreshReuseHandler(deps)(formRequest(body), forwarded);
    expect(await forwarded.mock.calls[0]![0].text()).toBe(body);
  });

  it('keeps repeated resource and extension parameters visible to the guard', async () => {
    const deps = makeRevokingDeps();
    const handle = createRefreshReuseHandler(deps);
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:first' }), deps);
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:second' }), deps);
    const replay = await handle(
      formRequest(
        new URLSearchParams([
          ['grant_type', 'refresh_token'],
          ['refresh_token', 'u:g:first'],
          ['client_id', 'client-1'],
          ['scope', 'mcp'],
          ['resource', 'https://kilo-mcp.test/mcp'],
          ['resource', 'https://kilo-mcp.test/mcp/other'],
          ['unknown_extension', 'value'],
        ]).toString()
      ),
      vi.fn()
    );
    expect(replay.status).toBe(400);
    expect(deps.revokeGrant).toHaveBeenCalledExactlyOnceWith('g', 'u');
  });

  it('leaves a repeated non-resource parameter to the library', async () => {
    const deps = makeRevokingDeps();
    const handle = createRefreshReuseHandler(deps);
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:first' }), deps);
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:second' }), deps);
    const forward = vi.fn(async () => Response.json({ error: 'invalid_request' }, { status: 400 }));
    const response = await handle(
      formRequest(
        'grant_type=refresh_token&refresh_token=u:g:first&refresh_token=u:g:second&client_id=c'
      ),
      forward
    );
    expect(forward).toHaveBeenCalledOnce();
    expect(response.status).toBe(400);
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });
});
