import { z } from 'zod';
import {
  PatRecordSchema,
  createVerifier,
  type FeedFetch,
  type PatLookupResult,
  type RevocationList,
  type WaitUntil,
} from '../../../src/index';

/**
 * Test-only Worker for runtime.test.ts: one isolate-scoped verifier, as a service holds it, with
 * both issuers. Each dependency (STS key set, UTS key set, revocation feed, PAT lookup) is a
 * stand-in that answers after a timer: workerd ties a timer to the request that set it, as it
 * ties a real fetch, so a request that awaited another request's pending call would stall here.
 * `hang` makes one numbered call of one dependency never answer, as a call cancelled with its
 * request never answers. `SELF` sends real requests to this Worker, so `/race` can cancel one.
 */

const SCOPE = 'session-ingest:events.write';

const DependencySchema = z.enum(['stsJwks', 'utsJwks', 'feed', 'pat']);
type Dependency = z.infer<typeof DependencySchema>;

const SetupSchema = z.object({
  stsJwks: z.unknown(),
  utsJwks: z.unknown(),
  delayMs: z.number().int().nonnegative(),
  pat: z.object({ hash: z.string(), record: PatRecordSchema }).nullable(),
  hang: z.object({ dependency: DependencySchema, call: z.number().int().positive() }).nullable(),
});
type Setup = z.infer<typeof SetupSchema>;

const IssuerSchema = z.enum(['sts', 'uts']);

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
const calls: Record<Dependency, number> = { stsJwks: 0, utsJwks: 0, feed: 0, pat: 0 };

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

const emptyList: RevocationList = {
  revokedBefore: new Map(),
  revokedSids: new Set(),
  revokedKids: new Set(),
  revokedPatIds: new Set(),
  blockedAccounts: new Set(),
};

const verifier = createVerifier({
  audience: 'session-ingest',
  resourceMetadataUrl: 'https://session-ingest.runtime.test/.well-known/oauth-protected-resource',
  sts: {
    issuer: 'https://sts.runtime.test',
    scopeRegistry: { 'session-ingest': { scopes: [SCOPE] } },
    jwks: async () => {
      await call('stsJwks');
      return setup.stsJwks;
    },
  },
  uts: {
    issuer: 'https://uts.runtime.test',
    isTokenKid: kid => kid.startsWith('uts-token-'),
    scopeRegistry: (audience, scope) =>
      audience === 'session-ingest' && scope === SCOPE
        ? { requiresSession: false, patEligible: true }
        : null,
    jwks: async () => {
      await call('utsJwks');
      return setup.utsJwks;
    },
    revocation: {
      async fetch(held): Promise<FeedFetch> {
        await call('feed');
        const head = { issuedAt: Date.now(), listHash: 'runtime-list' };
        return { head, list: held?.listHash === head.listHash ? null : emptyList };
      },
    },
    pat: {
      workload: 'session-ingest',
      cacheKeys: { current: { version: 'v1', secret: 'runtime-test-cache-key' } },
      lookup: async (hash): Promise<PatLookupResult> => {
        await call('pat');
        return setup.pat?.hash === hash
          ? { status: 'found', record: setup.pat.record }
          : { status: 'not_found' };
      },
    },
  },
});

/** The control: a promise one request leaves pending and a later request settles. */
let stranded: PromiseWithResolvers<void> | null = null;

/**
 * The first request is cancelled after 100 ms while its call is in flight; the second arrives
 * right after and must not depend on the first request's call.
 */
async function race(request: Request, env: Env, issuer: string): Promise<Response> {
  const forward = () =>
    new Request(`http://runtime.test/verify?issuer=${issuer}`, {
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
    switch (url.pathname) {
      case '/setup':
        setup = SetupSchema.parse(await request.json());
        return new Response('ok');
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
        return await race(request, env, IssuerSchema.parse(url.searchParams.get('issuer')));
      case '/verify': {
        const result = await verifier.verify(
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
