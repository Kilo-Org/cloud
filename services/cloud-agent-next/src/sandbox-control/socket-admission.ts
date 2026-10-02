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

export async function admitSandboxWrapperUpgrade(
  request: Request,
  env: Pick<Env, 'NEXTAUTH_SECRET' | 'SANDBOX_CONTROL'>,
  sandboxId: string
): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }
  if (!isSandboxControlId(sandboxId)) return new Response('Invalid sandboxId', { status: 400 });
  const token = parseSandboxLaunchBearer(request.headers.get('Authorization'));
  if (token === null)
    return new Response('Invalid or missing Authorization header', { status: 401 });
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) return new Response('Authentication unavailable', { status: 503 });
  const launch = verifySandboxLaunchCredential(token, secret);
  if (launch === null || launch.sandboxId !== sandboxId) return rejectSandboxWrapperUpgrade();
  return getSandboxControlStub(env, sandboxId).fetch(request);
}
