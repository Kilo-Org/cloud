import { createExecutionContext, env, runInDurableObject, SELF } from 'cloudflare:test';
import { createDrizzleClient } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eSurfaceApp, isCallbackIngestRequest } from '../../../src/e2e-surface/app.js';
import { E2E_CALLBACK_TOKEN_TTL_MS } from '../../../src/persistence/E2eCallbackSink.js';

/**
 * e2e-only callback sink contract, in the real Workers runtime against the real
 * `src/e2e-entry.ts`. Proves the binding reaches the class, the single
 * authorization exemption from both the secret and JWT gates, the owner check,
 * and the bounded record set.
 */

const ALLOWED_USER = 'usr_e2e_callback_allowed';
const SECOND_ALLOWED_USER = 'usr_e2e_callback_second';
const SESSION_ID = `agent_${crypto.randomUUID()}`;

const BODY_LIMIT_BYTES = 64 * 1024;
const RECORD_LIMIT = 50;

type CallbackSinkMeta = {
  ownerUserId: string;
  createdAt: number;
  expiresAt: number;
  count: number;
};

let secret: string;
let internalApiSecret: string;
const db = createDrizzleClient({
  connectionString: env.HYPERDRIVE.connectionString,
  poolConfig: { max: 1 },
});

function tokenFor(userId: string): string {
  return jwt.sign(
    {
      env: 'development',
      kiloUserId: userId,
      apiTokenPepper: `pepper-${userId}`,
      version: 3,
      tokenSource: 'cloud-agent',
    },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

function invalidToken(): string {
  return jwt.sign(
    {
      env: 'development',
      kiloUserId: ALLOWED_USER,
      apiTokenPepper: `pepper-${ALLOWED_USER}`,
      version: 3,
      tokenSource: 'cloud-agent',
    },
    'not-the-nextauth-secret',
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

function callbackSink() {
  const namespace = env.E2E_CALLBACK_SINK;
  if (!namespace) throw new Error('test config did not bind E2E_CALLBACK_SINK');
  return namespace;
}

/** Both gates: the e2e secret plus the bearer. */
function authorizedHeaders(userToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${userToken}`,
    'x-internal-api-key': internalApiSecret,
  };
}

async function mint(userToken: string): Promise<{ token: string; callbackUrl: string }> {
  const response = await SELF.fetch(
    new Request('https://worker.test/__e2e/callbacks', {
      method: 'POST',
      headers: authorizedHeaders(userToken),
    })
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string; callbackUrl: string };
}

/** Ingest carries no credential: the path token is the only authorization. */
function ingest(pathToken: string, body: string): Promise<Response> {
  return SELF.fetch(
    new Request(`https://worker.test/__e2e/callbacks/${pathToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  );
}

function read(pathToken: string, userToken: string): Promise<Response> {
  return SELF.fetch(
    new Request(`https://worker.test/__e2e/callbacks/${pathToken}`, {
      headers: authorizedHeaders(userToken),
    })
  );
}

function deleteToken(pathToken: string, userToken: string): Promise<Response> {
  return SELF.fetch(
    new Request(`https://worker.test/__e2e/callbacks/${pathToken}`, {
      method: 'DELETE',
      headers: authorizedHeaders(userToken),
    })
  );
}

beforeAll(async () => {
  const configuredSecret = env.NEXTAUTH_SECRET;
  if (typeof configuredSecret !== 'string' || configuredSecret.length === 0) {
    throw new Error('test config did not bind a string NEXTAUTH_SECRET');
  }
  secret = configuredSecret;

  const configuredInternalSecret = env.INTERNAL_API_SECRET;
  if (typeof configuredInternalSecret !== 'string' || configuredInternalSecret.length === 0) {
    throw new Error('test config did not bind a string INTERNAL_API_SECRET');
  }
  internalApiSecret = configuredInternalSecret;

  await db.db
    .insert(kilocode_users)
    .values(
      [ALLOWED_USER, SECOND_ALLOWED_USER].map(userId => ({
        id: userId,
        google_user_email: `${userId}@e2e.test`,
        google_user_name: 'E2E Callback Sink',
        google_user_image_url: 'https://example.test/avatar.png',
        stripe_customer_id: `cus_${userId}`,
        api_token_pepper: `pepper-${userId}`,
        is_admin: false,
      }))
    )
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.db
    .delete(kilocode_users)
    .where(inArray(kilocode_users.id, [ALLOWED_USER, SECOND_ALLOWED_USER]))
    .catch(() => undefined);
  await db.pool.end().catch(() => undefined);
});

describe('callback surface authorization', () => {
  it('keeps every non-ingest route behind both gates', async () => {
    const unauthenticated: Array<[string, string]> = [
      ['GET', `/__e2e/inspect/allocation/${SESSION_ID}`],
      ['POST', '/__e2e/callbacks'],
      ['GET', '/__e2e/callbacks/unknown-token'],
      ['DELETE', '/__e2e/callbacks/unknown-token'],
    ];
    for (const [method, path] of unauthenticated) {
      const response = await SELF.fetch(new Request(`https://worker.test${path}`, { method }));
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('404s the removed prepare route when authenticated with both credentials', async () => {
    // The wildcard `/__e2e/*` middleware runs before route resolution, so an
    // unauthenticated request 401s first. The route is provably gone only with
    // both credentials; no new exemption may be added to make this assertable.
    const response = await SELF.fetch(
      new Request('https://worker.test/__e2e/prepare', {
        method: 'POST',
        headers: authorizedHeaders(tokenFor(ALLOWED_USER)),
      })
    );
    expect(response.status).toBe(404);
  });

  it('accepts a valid path token and rejects a wrong one without either credential', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    const accepted = await ingest(minted.token, JSON.stringify({ messageId: 'message_1' }));
    expect(accepted.status).toBe(200);

    const rejected = await ingest('not-a-real-token', JSON.stringify({ messageId: 'x' }));
    expect(rejected.status).toBe(404);
  });

  it('ingests with an unset or empty Worker secret and a wrong key', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    for (const binding of [undefined, '']) {
      const response = await e2eSurfaceApp.fetch(
        new Request(`https://worker.test/__e2e/callbacks/${minted.token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ binding: String(binding) }),
        }),
        { ...env, INTERNAL_API_SECRET: binding },
        createExecutionContext()
      );
      expect(response.status, `binding=${String(binding)}`).toBe(200);
    }

    const wrongKey = await SELF.fetch(
      new Request(`https://worker.test/__e2e/callbacks/${minted.token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${invalidToken()}`,
          'x-internal-api-key': 'wrong-key-value',
        },
        body: JSON.stringify({ wrongKey: true }),
      })
    );
    expect(wrongKey.status).toBe(200);
  });

  it('gains no exemption from extra or trailing path segments', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    const paths = [`/__e2e/callbacks/${minted.token}/extra`, `/__e2e/callbacks/${minted.token}/`];
    for (const path of paths) {
      const unauthGet = await SELF.fetch(new Request(`https://worker.test${path}`));
      expect(unauthGet.status, `GET ${path}`).toBe(401);

      const unauthPost = await SELF.fetch(
        new Request(`https://worker.test${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      );
      expect(unauthPost.status, `POST ${path}`).toBe(401);
    }
  });

  it('keeps the ingest exemption exact at the case and query boundaries', async () => {
    // The exemption is method-and-path exact. Widening the predicate (a
    // case-insensitive regex, a prefix match, or matching the raw URL) must fail
    // here, because the HTTP boundary alone would not catch it: Hono's routing
    // is case-sensitive, so a widened predicate can still 404 instead of 200.
    expect(isCallbackIngestRequest('POST', '/__e2e/callbacks/token')).toBe(true);
    const nonExempt: Array<[string, string]> = [
      ['post', '/__e2e/callbacks/token'],
      ['GET', '/__e2e/callbacks/token'],
      ['POST', '/__E2E/callbacks/token'],
      ['POST', '/__e2e/CALLBACKS/token'],
      ['POST', '/__e2e/callbacks/token/'],
      ['POST', '/__e2e/callbacks/token/extra'],
      ['POST', '/__e2e/callbacks'],
    ];
    for (const [method, path] of nonExempt) {
      expect(isCallbackIngestRequest(method, path), `${method} ${path}`).toBe(false);
    }

    // `c.req.path` excludes the query string, so a legitimate ingest keeps its
    // exemption with a query appended; a regression that matched the raw URL
    // would 401 here.
    const minted = await mint(tokenFor(ALLOWED_USER));
    const withQuery = await SELF.fetch(
      new Request(`https://worker.test/__e2e/callbacks/${minted.token}?scenario=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: true }),
      })
    );
    expect(withQuery.status).toBe(200);

    const trailingSlash = await SELF.fetch(
      new Request(`https://worker.test/__e2e/callbacks/${minted.token}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trailingSlash: true }),
      })
    );
    expect(trailingSlash.status).toBe(401);
  });

  it('requires credentials on read and delete of a minted token', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    const unauthRead = await SELF.fetch(
      new Request(`https://worker.test/__e2e/callbacks/${minted.token}`)
    );
    expect(unauthRead.status).toBe(401);

    const unauthDelete = await SELF.fetch(
      new Request(`https://worker.test/__e2e/callbacks/${minted.token}`, { method: 'DELETE' })
    );
    expect(unauthDelete.status).toBe(401);
  });

  it('enforces the recorded owner on read and delete with a correct key', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    await ingest(minted.token, JSON.stringify({ messageId: 'message_1' }));

    const ownerRead = await read(minted.token, tokenFor(ALLOWED_USER));
    expect(ownerRead.status).toBe(200);

    const ownerSecondRead = await read(minted.token, tokenFor(SECOND_ALLOWED_USER));
    expect(ownerSecondRead.status).toBe(403);

    const ownerSecondDelete = await deleteToken(minted.token, tokenFor(SECOND_ALLOWED_USER));
    expect(ownerSecondDelete.status).toBe(403);

    const ownerDelete = await deleteToken(minted.token, tokenFor(ALLOWED_USER));
    expect(ownerDelete.status).toBe(204);
    expect((await read(minted.token, tokenFor(ALLOWED_USER))).status).toBe(404);
  });
});

describe('callback sink bounds', () => {
  it('mints an absolute callback URL on the request origin', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    expect(minted.callbackUrl).toBe(`https://worker.test/__e2e/callbacks/${minted.token}`);
  });

  it('arms a one-hour TTL alarm when the token is minted', async () => {
    const before = Date.now();
    const minted = await mint(tokenFor(ALLOWED_USER));
    const scheduled = await runInDurableObject(
      callbackSink().getByName(minted.token),
      async (_instance, state) => state.storage.getAlarm()
    );

    expect(scheduled).not.toBeNull();
    expect(scheduled!).toBeGreaterThanOrEqual(before + E2E_CALLBACK_TOKEN_TTL_MS);
    expect(scheduled!).toBeLessThanOrEqual(Date.now() + E2E_CALLBACK_TOKEN_TTL_MS);
  });

  it('rejects a body over 64 KiB with 413', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    const response = await ingest(
      minted.token,
      JSON.stringify({ blob: 'a'.repeat(BODY_LIMIT_BYTES + 1024) })
    );
    expect(response.status).toBe(413);
  });

  it('accepts a body of exactly 65,536 bytes', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    // The limit is inclusive: at the byte count it is accepted. ASCII only, so
    // `body.length` is the byte length.
    const prefix = '{"blob":"';
    const suffix = '"}';
    const body = prefix + 'a'.repeat(BODY_LIMIT_BYTES - prefix.length - suffix.length) + suffix;
    expect(body.length).toBe(BODY_LIMIT_BYTES);

    expect((await ingest(minted.token, body)).status).toBe(200);
  });

  it('rejects a single chunk that straddles the limit', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    // Two 40 KiB chunks: the first fits, the second starts below the limit and
    // ends above it. A 16 KiB-multiple regression would never exercise a
    // partially-over chunk; pulling exactly twice proves the reader cancels at
    // the first excess byte instead of accepting a chunk that began in bounds.
    const chunk = new Uint8Array(40 * 1024).fill(0x61);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 2) {
          controller.close();
          return;
        }
        controller.enqueue(chunk.slice());
      },
    });

    const response = await SELF.fetch(
      new Request(`https://worker.test/__e2e/callbacks/${minted.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    );

    expect(response.status).toBe(413);
    expect(pulls).toBe(2);
  });

  it('stops reading an over-limit chunked body as soon as it crosses the limit', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    const chunk = new Uint8Array(16 * 1024).fill(0x61);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        // Bound the source so a bug that buffers the whole body still ends.
        if (pulls > 8) {
          controller.close();
          return;
        }
        controller.enqueue(chunk.slice());
      },
    });

    const response = await SELF.fetch(
      new Request(`https://worker.test/__e2e/callbacks/${minted.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    );

    expect(response.status).toBe(413);
    // 4 chunks are exactly 64 KiB; the 5th crosses the limit. The source offers
    // up to 8 chunks, so pulling exactly 5 proves the handler stopped at the
    // limit instead of buffering the body.
    expect(pulls).toBe(5);
  });

  it('rejects invalid JSON with 400', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    expect((await ingest(minted.token, 'not json')).status).toBe(400);
  });

  it('caps each token at 50 records in arrival order', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    for (let index = 0; index < RECORD_LIMIT; index += 1) {
      expect((await ingest(minted.token, JSON.stringify({ index }))).status).toBe(200);
    }
    expect((await ingest(minted.token, JSON.stringify({ index: RECORD_LIMIT }))).status).toBe(409);

    const response = await read(minted.token, tokenFor(ALLOWED_USER));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: unknown[] };
    expect(body.records).toHaveLength(RECORD_LIMIT);
    expect(body.records[0]).toEqual({ index: 0 });
    expect(body.records[RECORD_LIMIT - 1]).toEqual({ index: RECORD_LIMIT - 1 });
  });

  it('rejects an expired token on read and ingest', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    await runInDurableObject(callbackSink().getByName(minted.token), async (_instance, state) => {
      const meta = (await state.storage.get('meta')) as CallbackSinkMeta;
      await state.storage.put('meta', { ...meta, expiresAt: Date.now() - 1000 });
    });

    expect((await read(minted.token, tokenFor(ALLOWED_USER))).status).toBe(404);
    expect((await ingest(minted.token, JSON.stringify({ late: true }))).status).toBe(404);
  });

  it('deletes the token when the TTL alarm fires', async () => {
    const minted = await mint(tokenFor(ALLOWED_USER));
    await ingest(minted.token, JSON.stringify({ delivered: true }));
    expect((await read(minted.token, tokenFor(ALLOWED_USER))).status).toBe(200);

    await runInDurableObject(callbackSink().getByName(minted.token), async instance => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });

    expect((await read(minted.token, tokenFor(ALLOWED_USER))).status).toBe(404);
  });
});
