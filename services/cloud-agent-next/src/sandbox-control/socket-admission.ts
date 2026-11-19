import { resolveSecret } from '../auth.js';
import type { Env } from '../types.js';
import { parseSandboxLaunchBearer, verifySandboxLaunchCredential } from './credential.js';
import { getSandboxControlStub, isSandboxControlId } from './stub.js';

export function rejectSandboxWrapperUpgrade(): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].send(JSON.stringify({ type: 'shutdown', reason: 'hello_rejected' }));
  pair[1].close(1008, 'shutdown');
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export type SandboxLaunch = NonNullable<ReturnType<typeof verifySandboxLaunchCredential>>;

export type WrapperLaunchVerdict =
  | { ok: true; launch: SandboxLaunch }
  | { ok: false; refusal: Response | 'rejected' };

/**
 * The Worker-side check of a wrapper socket: the upgrade, the sandbox id and
 * the signed launch credential for that sandbox. A `rejected` verdict means a
 * credential that is present but not valid; each route answers it its own way.
 */
export async function verifyWrapperLaunch(
  request: Request,
  env: Pick<Env, 'NEXTAUTH_SECRET'>,
  sandboxId: string
): Promise<WrapperLaunchVerdict> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return { ok: false, refusal: new Response('Expected WebSocket upgrade', { status: 426 }) };
  }
  if (!isSandboxControlId(sandboxId)) {
    return { ok: false, refusal: new Response('Invalid sandboxId', { status: 400 }) };
  }
  const token = parseSandboxLaunchBearer(request.headers.get('Authorization'));
  if (token === null) {
    const refusal = new Response('Invalid or missing Authorization header', { status: 401 });
    return { ok: false, refusal };
  }
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) {
    return { ok: false, refusal: new Response('Authentication unavailable', { status: 503 }) };
  }
  const launch = verifySandboxLaunchCredential(token, secret);
  if (launch === null || launch.sandboxId !== sandboxId) return { ok: false, refusal: 'rejected' };
  return { ok: true, launch };
}

export async function admitSandboxWrapperUpgrade(
  request: Request,
  env: Pick<Env, 'NEXTAUTH_SECRET' | 'SANDBOX_CONTROL'>,
  sandboxId: string
): Promise<Response> {
  const verdict = await verifyWrapperLaunch(request, env, sandboxId);
  if (!verdict.ok) {
    return verdict.refusal === 'rejected' ? rejectSandboxWrapperUpgrade() : verdict.refusal;
  }
  return getSandboxControlStub(env, sandboxId).fetch(request);
}
