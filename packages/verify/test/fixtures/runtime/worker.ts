import { base64url } from 'jose';
import { z } from 'zod';
import {
  FEED_HEAD_TYPE,
  PatRecordSchema,
  createVerifier,
  type PatLookupResult,
  type RevocationFeedSource,
  type RevocationListWire,
  type UtsBootstrapSource,
  type VerifierConfig,
  type WaitUntil,
} from '../../../src/index';

/**
 * Test-only Worker for runtime.test.ts: two isolate-scoped verifiers, as a service holds one, with
 * both issuers; `bootstrap` loads a cold UTS state through the bootstrap port, `separate` through
 * the UTS key set and the feed. Each dependency (STS key set, UTS key set, feed, bootstrap, PAT
 * lookup) is a stand-in that answers after a timer: workerd ties a timer to the request that set
 * it, as it ties a real fetch, so a request that awaited another request's pending call would stall
 * here. `hang` makes one numbered call of one dependency never answer, as a call cancelled with its
 * request never answers. `SELF` sends real requests to this Worker, so `/race` can cancel one.
 */

const SCOPE = 'session-ingest:events.write';

const DependencySchema = z.enum(['stsJwks', 'utsJwks', 'feed', 'bootstrap', 'pat']);
type Dependency = z.infer<typeof DependencySchema>;

const SetupSchema = z.object({
  stsJwks: z.object({ keys: z.array(z.unknown()) }),
  utsJwks: z.object({ keys: z.array(z.unknown()) }),
  delayMs: z.number().int().nonnegative(),
  pat: z.object({ hash: z.string(), record: PatRecordSchema }).nullable(),
  hang: z.object({ dependency: DependencySchema, call: z.number().int().positive() }).nullable(),
});
type Setup = z.infer<typeof SetupSchema>;

const IssuerSchema = z.enum(['sts', 'uts']);
const ColdSchema = z.enum(['bootstrap', 'separate']);

type Env = {
  SELF: { fetch(request: Request, init?: { signal?: AbortSignal }): Promise<Response> };
};

let setup: Setup = {
  stsJwks: { keys: [] },
  utsJwks: { keys: [] },
  delayMs: 0,
  pat: null,
  hang: null,
};
const calls: Record<Dependency, number> = {
  stsJwks: 0,
  utsJwks: 0,
  feed: 0,
  bootstrap: 0,
  pat: 0,
};

/** The feed object's key, made at `/setup`; its public half joins the UTS key set. */
let feedKey: { privateKey: CryptoKey; jwk: Record<string, unknown> } | null = null;
const FEED_KID = 'uts-feed-0-runtime';

const LIST: RevocationListWire = {
  revoked_before: {},
  revoked_sids: [],
  revoked_kids: [],
  revoked_pat_ids: [],
  blocked_accounts: [],
};
const LIST_BYTES = new TextEncoder().encode(JSON.stringify(LIST));

/** Counts a call of `dependency`, then answers after `setup.delayMs` on the caller's timer, or never. */
async function call(dependency: Dependency): Promise<void> {
  calls[dependency]++;
  if (setup.hang?.dependency === dependency && setup.hang.call === calls[dependency]) {
    await Promise.withResolvers<never>().promise;
  }
  const answer = Promise.withResolvers<void>();
  setTimeout(answer.resolve, setup.delayMs);
  await answer.promise;
}

function utsKeys(): { keys: unknown[] } {
  return { keys: [...setup.utsJwks.keys, ...(feedKey === null ? [] : [feedKey.jwk])] };
}

async function signedHead(): Promise<string> {
  if (feedKey === null) throw new Error('no feed key: call /setup first');
  const listHash = base64url.encode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', LIST_BYTES))
  );
  const encode = (value: unknown) => base64url.encode(JSON.stringify(value));
  const input = `${encode({ alg: 'EdDSA', typ: FEED_HEAD_TYPE, kid: FEED_KID })}.${encode({
    iat: Math.floor(Date.now() / 1000),
    list_hash: listHash,
  })}`;
  const signature = await crypto.subtle.sign(
    'Ed25519',
    feedKey.privateKey,
    new TextEncoder().encode(input)
  );
  return `${input}.${base64url.encode(new Uint8Array(signature))}`;
}

const revocation: RevocationFeedSource = {
  async head() {
    await call('feed');
    return await signedHead();
  },
  async list() {
    return LIST_BYTES;
  },
};

/** The fixture's UTS key set is always freshly read. */
const KEY_AGES = { newest: 0, oldest: 0 };

const bootstrap: UtsBootstrapSource = async () => {
  await call('bootstrap');
  return { jwks: utsKeys(), keyAges: KEY_AGES, head: await signedHead(), list: LIST_BYTES };
};

function config(cold: 'bootstrap' | 'separate') {
  return {
    audience: 'session-ingest',
    environment: 'development',
    resourceMetadataUrl: 'https://session-ingest.runtime.test/.well-known/oauth-protected-resource',
    sts: {
      issuer: 'https://sts.runtime.test',
      scopeRegistry: { 'session-ingest': { scopes: [SCOPE] } },
      jwks: async () => {
        await call('stsJwks');
        return { body: setup.stsJwks, age: null, oldestAge: null };
      },
    },
    uts: {
      issuer: 'https://uts.runtime.test',
      scopeRegistry: (audience: string, scope: string) =>
        audience === 'session-ingest' && scope === SCOPE
          ? { requiresSession: false, patEligible: true }
          : null,
      jwks: async () => {
        await call('utsJwks');
        return { body: utsKeys(), age: 0, oldestAge: 0 };
      },
      revocation,
      bootstrap: cold === 'bootstrap' ? bootstrap : undefined,
      pat: {
        workload: 'session-ingest',
        cacheKeys: async () => ({ current: { version: 'v1', secret: 'runtime-test-cache-key' } }),
        lookup: async (hash: string): Promise<PatLookupResult> => {
          await call('pat');
          return setup.pat?.hash === hash
            ? { status: 'found', record: setup.pat.record }
            : { status: 'not_found' };
        },
      },
    },
  } satisfies VerifierConfig;
}

const verifiers = {
  bootstrap: createVerifier(config('bootstrap')),
  separate: createVerifier(config('separate')),
};

/** The control: a promise one request leaves pending and a later request settles. */
let stranded: PromiseWithResolvers<void> | null = null;

/**
 * The first request is cancelled after 100 ms while its call is in flight; the second arrives
 * right after and must not depend on the first request's call.
 */
async function race(request: Request, env: Env, query: string): Promise<Response> {
  const forward = () =>
    new Request(`http://runtime.test/verify?${query}`, {
      headers: { authorization: request.headers.get('authorization') ?? '' },
    });
  const first = await env.SELF.fetch(forward(), { signal: AbortSignal.timeout(100) }).then(
    response => response.status,
    () => 'cancelled'
  );
  const startedAt = Date.now();
  const second = await env.SELF.fetch(forward(), { signal: AbortSignal.timeout(4_000) }).then(
    async (response): Promise<unknown> => {
      const body: unknown = await response.json();
      return body;
    },
    () => 'timed_out'
  );
  return Response.json({ first, second, secondMs: Date.now() - startedAt });
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil: WaitUntil }): Promise<Response> {
    const url = new URL(request.url);
    const cold = ColdSchema.parse(url.searchParams.get('cold') ?? 'bootstrap');
    switch (url.pathname) {
      case '/setup': {
        setup = SetupSchema.parse(await request.json());
        const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
        if (!('privateKey' in pair)) throw new Error('expected a key pair');
        const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
        feedKey = {
          privateKey: pair.privateKey,
          jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: FEED_KID },
        };
        return new Response('ok');
      }
      case '/calls':
        return Response.json(calls);
      case '/strand':
        stranded = Promise.withResolvers<void>();
        void stranded.promise.then(() => {});
        return new Response('stranded');
      case '/settle':
        stranded?.resolve();
        return new Response('settled');
      case '/race':
        return await race(request, env, url.searchParams.toString());
      case '/warm':
        verifiers[cold].warm({ waitUntil: promise => ctx.waitUntil(promise) });
        return new Response('warming');
      case '/verify': {
        const result = await verifiers[cold].verify(
          request,
          { issuer: IssuerSchema.parse(url.searchParams.get('issuer')), scope: SCOPE },
          { waitUntil: promise => ctx.waitUntil(promise), clientAddress: '203.0.113.7' }
        );
        if (!result.ok) {
          return Response.json({ ok: false, status: result.status, reason: result.reason });
        }
        return Response.json({ ok: true, caller: result.caller.kind });
      }
      default:
        return new Response('not found', { status: 404 });
    }
  },
};
