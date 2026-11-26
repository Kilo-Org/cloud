import {
  JWKS_PATH,
  type BundleRequest,
  type BundleResult,
  type MintResult,
} from '@kilocode/sts-contracts';
import { decodeProtectedHeader } from 'jose';
import { serveBundle, SecretsBroker } from '../../../src/broker';
import { RefresherDO as StsRefresherDO } from '../../../src/dos/RefresherDO';
import { SignerDO as StsSignerDO, type ManagerJwks } from '../../../src/dos/SignerDO';
import { getBundleStub } from '../../../src/dos/stubs';
import { MANAGER_JWKS_PATH, readConfig, type Env } from '../../../src/env';
import { handleRequest, MANAGER_WEBHOOK_PATH } from '../../../src/http';
import { IdentityVerifier } from '../../../src/identity/verify';
import { workloadPolicyHash } from '../../../src/policy';
import { loadPolicies } from '../../../src/policy/load';
import type { MintAuthority } from '../../../src/tokens/mint';
import type { FillResult } from '../../../src/types';
import { createProvider, providerFetch, signToken } from '../../worker/support';

export { BundleDO, DenialDO, LeaseDO, TokenSignerDO } from '../../../src/index';

/**
 * Test-only Worker for test/runtime; never deployed. `BROKER` binds its own `ProbeBroker`
 * entrypoint with `props.caller`, so a bundle read is a real RPC call into STS's broker code;
 * `MINTER` binds `ProbeMinter` the same way for mint calls, and `SELF` sends real requests to STS's
 * own HTTP routes in this isolate. The Durable Object classes run in this isolate too, so the
 * counters below see their calls.
 */
type ProbeEnv = Env & {
  BROKER: Service<ProbeBroker>;
  MINTER: Service<ProbeMinter>;
  SELF: Fetcher;
};

/** The shipped scope registry is empty, so the minter checks against this one. */
const RUNTIME_SCOPES = { 'runtime-target': { scopes: ['runtime-target:probe.read'] } };

const RUNTIME_AUTHORITY: MintAuthority = {
  scopes: RUNTIME_SCOPES,
  policies: loadPolicies(
    {
      'sts-runtime-probe.yaml': `
workload: sts-runtime-probe
environments: [development]
identity:
  kind: worker-binding
secrets: []
audiences: [runtime-target]
scopes: ['runtime-target:probe.read']
`,
    },
    { scopeRegistry: RUNTIME_SCOPES }
  ),
};

export class ProbeMinter extends SecretsBroker {
  static override readonly mintAuthority = RUNTIME_AUTHORITY;
}

/** How long the signer, refresher and identity provider take to answer the calls STS caches. */
const SLOW_CALL_MS = 500;

/** How long the refresher takes to build a bundle for an empty bundle object. */
const SLOW_FILL_MS = 1_000;

const FLY_ISSUER = 'https://oidc.fly.io/acme';

const FLY_POLICY = `
workload: fly-app
environments: [development]
identity:
  kind: fly-oidc
  org: acme
  orgId: '1111'
  app: fly-app
  appId: '2222'
secrets: [APP_SECRET]
`;

/** Calls into one slow dependency: how many started and how many answered. */
type Calls = { started: number; completed: number };

/**
 * The slow dependencies STS caches. Each one's first call never answers, as a call cancelled with
 * its request never settles for anyone awaiting it; later calls answer after `SLOW_CALL_MS`. So
 * when the second racer answers, `completed` shows its answer came from a call of its own.
 */
const calls = {
  jwks: { started: 0, completed: 0 },
  webhook: { started: 0, completed: 0 },
  identity: { started: 0, completed: 0 },
} satisfies Record<string, Calls>;

async function slowCall<T>(counter: Calls, answer: () => Promise<T>): Promise<T> {
  counter.started += 1;
  if (counter.started === 1) await Promise.withResolvers<never>().promise;
  await scheduler.wait(SLOW_CALL_MS);
  const value = await answer();
  counter.completed += 1;
  return value;
}

/** Bundles the refresher built for an empty bundle object. */
let fillsBuilt = 0;

/**
 * One Fly app's verifier, kept for the isolate the way http.ts keeps STS's, with a slow local
 * provider, and a token it accepts. Built by the request that starts a race, before either racer.
 */
let identity: { verifier: IdentityVerifier; token: string } | null = null;

/** A promise a request created and left pending when it ended (the warning control). */
let stranded: PromiseWithResolvers<void> | null = null;

/** Broker calls whose context was still open 1 s after they returned. */
let brokerOpenAfterReturn = 0;

export class ProbeBroker extends SecretsBroker {
  override async getBundle(request: BundleRequest): Promise<BundleResult> {
    const result = await super.getBundle(request);
    // workerd cancels this timer when the call's context ends, so it fires only while a caller
    // still holds the call open.
    setTimeout(() => {
      brokerOpenAfterReturn += 1;
    }, 1_000);
    return result;
  }
}

/** STS's signer, slow to hand out its key set, so a request can end while the call is in flight. */
export class SignerDO extends StsSignerDO {
  override async getJwks(): Promise<ManagerJwks> {
    return await slowCall(calls.jwks, () => super.getJwks());
  }
}

/**
 * STS's refresher: slow to hand out the webhook secret, for the same reason, and building an
 * audit-relay bundle slowly without the manager, so a fill can outlive the broker's deadline.
 */
export class RefresherDO extends StsRefresherDO {
  override async webhookSecret(): Promise<string> {
    return await slowCall(calls.webhook, () => super.webhookSecret());
  }

  override async buildBundle(workload: string): Promise<FillResult> {
    await scheduler.wait(SLOW_FILL_MS);
    fillsBuilt += 1;
    return {
      status: 'built',
      bundle: {
        workload,
        secrets: { AUDIT_RELAY_AXIOM_TOKEN: { value: 'axiom-token', version: 3, id: 'id-axiom' } },
        missing: ['AUDIT_RELAY_SLACK_WEBHOOK_PAGE'],
        fetchedAt: new Date().toISOString(),
        policyHash: await workloadPolicyHash(workload),
        stale: false,
      },
    };
  }
}

async function readBundle(env: ProbeEnv): Promise<Response> {
  const config = readConfig(env);
  await getBundleStub(env, config, 'o11y').putBundle({
    workload: 'o11y',
    secrets: { O11Y_CF_AE_API_TOKEN: { value: 'ae-token', version: 7, id: 'id-ae' } },
    missing: [],
    fetchedAt: new Date().toISOString(),
    policyHash: await workloadPolicyHash('o11y'),
    stale: false,
  });
  // A caller that never disposes what it received, then keeps working past the broker's timer.
  const result = await env.BROKER.getBundle({});
  const work = Promise.withResolvers<void>();
  setTimeout(work.resolve, 1_500);
  await work.promise;
  return Response.json({ status: result.status, brokerOpenAfterReturn });
}

/**
 * Reads the audit-relay bundle through `serveBundle`, with `deadlineMs` when given. The request
 * then ends, so a call STS stopped waiting for is cancelled on STS's side.
 */
async function readFilled(env: ProbeEnv, deadlineMs: string | null): Promise<Response> {
  const startedAt = Date.now();
  const result = await serveBundle(
    env,
    readConfig(env),
    'audit-relay',
    {},
    deadlineMs === null ? {} : { deadlineMs: Number(deadlineMs) }
  );
  return Response.json({
    status: result.status,
    secrets: result.status === 'ok' ? result.secrets : null,
    ms: Date.now() - startedAt,
    fillsBuilt,
  });
}

function routeRequest(env: ProbeEnv, route: string | null): Request {
  const issuer = readConfig(env).issuer;
  if (route === 'webhook') {
    const now = Date.now();
    // Well-formed but signed with no known secret: the gate needs the secret to refuse it.
    return new Request(`${issuer}${MANAGER_WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'x-infisical-signature': `t=${now};${'0'.repeat(64)}` },
      body: JSON.stringify({ event: 'secrets.modified', timestamp: now }),
    });
  }
  if (route === 'identity') return new Request('http://probe.test/verify');
  return new Request(`${issuer}${MANAGER_JWKS_PATH}`);
}

/** The token's `iat` comes from the test so it can check the outcome exactly; it lives 10 minutes. */
async function buildIdentity(issuer: string, issuedAt: number): Promise<void> {
  const provider = await createProvider(FLY_ISSUER, issuer);
  const local = providerFetch([provider]);
  identity = {
    verifier: new IdentityVerifier({
      policies: loadPolicies({ 'fly-app.yaml': FLY_POLICY }).all(),
      environment: 'development',
      issuer,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        await slowCall(calls.identity, () => local.fetch(input, init)),
    }),
    token: await signToken(
      provider,
      {
        org_id: '1111',
        org_name: 'acme',
        app_id: '2222',
        app_name: 'fly-app',
        machine_id: 'machine-1',
      },
      { issuedAt, expiresAt: issuedAt + 600 }
    ),
  };
}

async function verifyIdentity(): Promise<Response> {
  if (identity === null) return new Response('no verifier', { status: 500 });
  const outcome = await identity.verifier.verify(identity.token);
  return Response.json(outcome, { status: outcome.status === 'verified' ? 200 : 403 });
}

function isRoute(route: string | null): route is keyof typeof calls {
  return route === 'jwks' || route === 'webhook' || route === 'identity';
}

/**
 * The first request is cancelled while its signer, refresher or provider call is in flight; the
 * second arrives right after and must not depend on the first request's call.
 */
async function race(env: ProbeEnv, url: URL): Promise<Response> {
  const route = url.searchParams.get('route');
  if (!isRoute(route)) return new Response('unknown route', { status: 400 });
  if (route === 'identity') {
    await buildIdentity(readConfig(env).issuer, Number(url.searchParams.get('issuedAt')));
  }
  const first = await env.SELF.fetch(routeRequest(env, route), {
    signal: AbortSignal.timeout(100),
  }).then(
    response => response.status,
    () => 'cancelled'
  );
  const startedAt = Date.now();
  const second = await env.SELF.fetch(routeRequest(env, route), {
    signal: AbortSignal.timeout(3_000),
  }).then(
    async response => ({ status: response.status, body: await response.text() }),
    () => ({ status: 'timed_out', body: '' })
  );
  return Response.json({
    first,
    second: second.status,
    body: second.body,
    secondMs: Date.now() - startedAt,
    calls: calls[route],
  });
}

/** The kid of the service-token key set STS serves, fetched as a real request. */
async function servedKid(env: ProbeEnv): Promise<string | null> {
  const response = await env.SELF.fetch(`${readConfig(env).issuer}${JWKS_PATH}`);
  const jwks: { keys: Array<{ kid: string }> } = await response.json();
  return jwks.keys[0]?.kid ?? null;
}

/**
 * Two key-set requests and two mint calls at once, on a cold isolate and a cold token signer:
 * each must be answered by work of its own, never by a promise another request created.
 */
async function coldTokens(env: ProbeEnv): Promise<Response> {
  const issuer = readConfig(env).issuer;
  const request = { tokens: [{ audience: 'runtime-target', scope: 'runtime-target:probe.read' }] };
  const keySet = async () => {
    const response = await env.SELF.fetch(`${issuer}${JWKS_PATH}`);
    const jwks: { keys: Array<{ kid: string }> } = await response.json();
    return { status: response.status, kids: jwks.keys.map(key => key.kid) };
  };
  const mint = async () => {
    const result: MintResult = await env.MINTER.mintTokens(request);
    if (result.status !== 'ok') return { status: result.status, kids: [] };
    return {
      status: result.status,
      kids: result.tokens.map(token =>
        token.status === 'issued' ? String(decodeProtectedHeader(token.token).kid) : token.reason
      ),
    };
  };
  return Response.json(await Promise.all([keySet(), keySet(), mint(), mint()]));
}

/** Calls the broker's former `mintAuthority()` method through the binding, as any caller could. */
async function authorityOverRpc(env: ProbeEnv): Promise<Response> {
  const binding = env.MINTER as unknown as { mintAuthority(): Promise<unknown> };
  try {
    await binding.mintAuthority();
    return Response.json({ reachable: true, error: null });
  } catch (error) {
    return Response.json({
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== 'probe.test') return await handleRequest(request, env, ctx);
    switch (url.pathname) {
      case '/read':
        return await readBundle(env);
      case '/fill':
        return await readFilled(env, url.searchParams.get('deadlineMs'));
      case '/race':
        return await race(env, url);
      case '/verify':
        return await verifyIdentity();
      case '/strand':
        stranded = Promise.withResolvers<void>();
        void stranded.promise.then(() => {});
        return new Response('stranded');
      case '/settle':
        stranded?.resolve();
        return new Response('settled');
      case '/fills':
        return new Response(String(fillsBuilt));
      case '/token-kid':
        return Response.json({ kid: await servedKid(env) });
      case '/cold-tokens':
        return await coldTokens(env);
      case '/mint-authority':
        return await authorityOverRpc(env);
      default:
        return new Response('not found', { status: 404 });
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
