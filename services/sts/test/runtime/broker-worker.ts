import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { SecretsBroker } from '../../src/broker';
import { RefresherDO as StsRefresherDO } from '../../src/dos/RefresherDO';
import { SignerDO as StsSignerDO, type ManagerJwks } from '../../src/dos/SignerDO';
import { getBundleStub } from '../../src/dos/stubs';
import { MANAGER_JWKS_PATH, readConfig, type Env } from '../../src/env';
import { handleRequest, MANAGER_WEBHOOK_PATH } from '../../src/http';
import { IdentityVerifier } from '../../src/identity/verify';
import { workloadPolicyHash } from '../../src/policy';
import { loadPolicies } from '../../src/policy/load';
import { createProvider, providerFetch, signToken } from '../worker/support';

export { BundleDO, DenialDO } from '../../src/index';

/**
 * Test-only Worker for the suites in this directory; never deployed. `BROKER` binds its own
 * `ProbeBroker` entrypoint with `props.caller`, so a bundle read is a real RPC call into STS's
 * broker code, and `SELF` sends real requests to STS's own HTTP routes in this isolate.
 */
type ProbeEnv = Env & { BROKER: Service<ProbeBroker>; SELF: Fetcher };

/** How long the signer, refresher and identity provider take to answer the calls STS caches. */
const SLOW_CALL_MS = 500;

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
    await scheduler.wait(SLOW_CALL_MS);
    return await super.getJwks();
  }
}

/** STS's refresher, slow to hand out the webhook secret, for the same reason. */
export class RefresherDO extends StsRefresherDO {
  override async webhookSecret(): Promise<string> {
    await scheduler.wait(SLOW_CALL_MS);
    return await super.webhookSecret();
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

async function buildIdentity(issuer: string): Promise<void> {
  const provider = await createProvider(FLY_ISSUER, issuer);
  const local = providerFetch([provider]);
  identity = {
    verifier: new IdentityVerifier({
      policies: loadPolicies({ 'fly-app.yaml': FLY_POLICY }).all(),
      environment: 'development',
      issuer,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        await scheduler.wait(SLOW_CALL_MS);
        return await local.fetch(input, init);
      },
    }),
    token: await signToken(provider, {
      org_id: '1111',
      org_name: 'acme',
      app_id: '2222',
      app_name: 'fly-app',
      machine_id: 'machine-1',
    }),
  };
}

async function verifyIdentity(): Promise<Response> {
  if (identity === null) return new Response('no verifier', { status: 500 });
  const outcome = await identity.verifier.verify(identity.token);
  return Response.json(outcome, { status: outcome.status === 'verified' ? 200 : 403 });
}

/**
 * The first request is cancelled while its signer, refresher or provider call is in flight; the
 * second arrives right after and must not depend on the first request's call.
 */
async function race(env: ProbeEnv, route: string | null): Promise<Response> {
  if (route === 'identity') await buildIdentity(readConfig(env).issuer);
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
  });
}

export default {
  async fetch(request: Request, env: ProbeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === 'probe.test' && url.pathname === '/read') return await readBundle(env);
    if (url.hostname === 'probe.test' && url.pathname === '/race') {
      return await race(env, url.searchParams.get('route'));
    }
    if (url.hostname === 'probe.test' && url.pathname === '/verify') return await verifyIdentity();
    if (url.hostname === 'probe.test' && url.pathname === '/strand') {
      stranded = Promise.withResolvers<void>();
      void stranded.promise.then(() => {});
      return new Response('stranded');
    }
    if (url.hostname === 'probe.test' && url.pathname === '/settle') {
      stranded?.resolve();
      return new Response('settled');
    }
    return await handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<ProbeEnv>;
