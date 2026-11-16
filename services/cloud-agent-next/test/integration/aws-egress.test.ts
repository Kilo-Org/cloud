import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import { handleAwsEgress } from '../../src/egress/aws-route.js';
import type { AwsScmAdmission } from '../../src/egress/aws-admission.js';
import type { Env } from '../../src/types.js';
import { awsEgressFixture } from '../fixtures/aws-egress.js';

const namespace = (env as unknown as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> })
  .SANDBOX_CONTROL;
const invalidProof = { credential: 'invalid-proof', identity: 'a'.repeat(64) };
afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

async function admittedSandbox() {
  const fixture = await awsEgressFixture();
  const sandboxId = fixture.context.sandboxId;
  const stub = namespace.getByName(sandboxId);
  const admitted: AwsScmAdmission[] = [];
  await runInDurableObject(stub, async instance => {
    await instance.getAllocationState();
    Reflect.set(instance, 'awsEgressAdmission', {
      ...fixture.api,
      admitScm(proof: typeof fixture.proof, request: AwsScmAdmission) {
        admitted.push(request);
        expect(Object.keys(request).sort()).toEqual(['authorization', 'target']);
        return fixture.api.admitScm(proof, request);
      },
    });
  });
  const workerEnv = { ...env, GIT_TOKEN_SERVICE: fixture.env.GIT_TOKEN_SERVICE } as unknown as Env;
  const target = 'https://github.com/acme/repo.git/git-receive-pack';
  const headers = {
    'x-kilo-egress-identity': fixture.proof.identity,
    'x-kilo-egress-credential': fixture.proof.credential,
    'x-kilo-egress-target': target,
    authorization: `Bearer ${fixture.scope.scm!.alias}`,
    host: 'proxy.invalid',
  };
  const forward = (request: Request) => handleAwsEgress(request, workerEnv, sandboxId, 'scm');
  return { fixture, admitted, target, headers, forward };
}

describe('AWS egress RPC transport', () => {
  it('initializes the actual sandbox and refuses absent allocation authority', async () => {
    const stub = namespace.getByName('sbx_aws_egress_absent');
    expect((await stub.getAwsEgressPolicy(invalidProof)).status).toBe(403);
    expect(
      await stub.admitAwsScm(invalidProof, {
        target: { url: 'https://github.com/test/repo.git', method: 'GET' },
        authorization: {},
      })
    ).toMatchObject({ ok: false, status: 403 });
  });

  it('validates real admission through DO RPC and streams a 1 MiB push only in the Worker route', async () => {
    const h = await admittedSandbox();
    const forwarded = vi.fn(async (request: Request) => {
      expect(request.url).toBe(h.target);
      expect(request.headers.get('host')).toBe('github.com');
      expect(request.headers.get('authorization')).toBe('Bearer upstream-secret');
      for (const header of [
        'x-kilo-egress-identity',
        'x-kilo-egress-credential',
        'x-kilo-egress-target',
      ])
        expect(request.headers.has(header)).toBe(false);
      expect(request.redirect).toBe('manual');
      return new Response(request.body, { status: 202 });
    });
    vi.stubGlobal('fetch', forwarded);
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const response = await h.forward(
      new Request('https://worker.test/scm', {
        method: 'POST',
        headers: h.headers,
        body: stream.readable,
      })
    );
    expect(response.status).toBe(202);
    // No body byte exists until admission and the single upstream forward finish.
    const received = response.arrayBuffer();
    const body = new Uint8Array(1024 * 1024).fill(71);
    await writer.write(body);
    await writer.close();
    expect(new Uint8Array(await received)).toEqual(body);
    expect(h.admitted).toHaveLength(1);
    expect(h.fixture.redeem).toHaveBeenCalledOnce();
    expect(forwarded).toHaveBeenCalledOnce();
  });

  it('refuses a retired grant without reading the body, redeeming, or forwarding', async () => {
    const h = await admittedSandbox();
    h.fixture.context.grants = [];
    const forwarded = vi.fn();
    vi.stubGlobal('fetch', forwarded);
    const request = new Request('https://worker.test/scm', {
      method: 'POST',
      headers: h.headers,
      body: 'private-push-body',
    });
    expect((await h.forward(request)).status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(h.fixture.redeem).not.toHaveBeenCalled();
    expect(forwarded).not.toHaveBeenCalled();
    await request.body?.cancel();
  });

  it('does not replay a push after an ambiguous upstream failure', async () => {
    const h = await admittedSandbox();
    const forwarded = vi.fn(async () => {
      throw new Error('response lost');
    });
    vi.stubGlobal('fetch', forwarded);
    const response = await h.forward(
      new Request('https://worker.test/scm', {
        method: 'POST',
        headers: h.headers,
        body: 'private-push-body',
      })
    );
    expect(response.status).toBe(502);
    expect(forwarded).toHaveBeenCalledOnce();
    expect(h.admitted).toHaveLength(1);
  });
});
