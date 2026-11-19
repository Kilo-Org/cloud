import { verifyWrapperLaunch } from '../sandbox-control/socket-admission.js';
import { getSandboxControlStub } from '../sandbox-control/stub.js';
import { PREVIEW_TUNNEL_CONNECT_HEADER } from '../shared/preview-headers.js';
import { previewTunnelName } from '../shared/preview-tunnel-protocol.js';
import type { Env } from '../types.js';

/**
 * Admits the wrapper's preview tunnel socket. The Worker checks the signed
 * launch credential, then the Sandbox DO checks that the allocation is the
 * current one and the credential matches. The request to the tunnel DO is new:
 * only the upgrade and the allocation from the verified credential go on, so
 * no header from the sandbox can reach the tunnel DO.
 */
export async function admitPreviewTunnelUpgrade(
  request: Request,
  env: Pick<Env, 'NEXTAUTH_SECRET' | 'SANDBOX_CONTROL' | 'PREVIEW_TUNNEL'>,
  sandboxId: string
): Promise<Response> {
  const verdict = await verifyWrapperLaunch(request, env, sandboxId);
  if (!verdict.ok) {
    return verdict.refusal === 'rejected'
      ? new Response('Preview tunnel refused', { status: 403 })
      : verdict.refusal;
  }
  const { allocationId, credential } = verdict.launch;
  const admitted = await getSandboxControlStub(env, sandboxId).admitPreviewTunnel(
    allocationId,
    credential
  );
  if (!admitted) return new Response('Preview tunnel refused', { status: 403 });
  const tunnel = env.PREVIEW_TUNNEL.getByName(previewTunnelName(sandboxId, allocationId));
  return tunnel.fetch('https://preview-tunnel.internal/connect', {
    headers: { Upgrade: 'websocket', [PREVIEW_TUNNEL_CONNECT_HEADER]: allocationId },
  });
}
