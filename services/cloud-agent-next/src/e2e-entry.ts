/**
 * e2e-only Worker entrypoint.
 *
 * It refuses every request that did not pass the Cloudflare Access application
 * in front of the e2e hostname (`e2e-surface/access-gate.ts`), mounts the
 * `/__e2e/*` inspect surface, and otherwise forwards every request (and
 * queue/scheduled event) to the production Worker unchanged. Production keeps
 * `main = src/index.ts`; this file is referenced only by the rendered e2e config
 * and the dedicated Workers test config, so no production route, dependency or
 * secret changes and the surface is unreachable on the production Worker by
 * construction.
 */

import { env as workerEnv } from 'cloudflare:workers';
import production from './index.js';
import { e2eSurfaceApp } from './e2e-surface/app.js';
import {
  withAccessCredentials,
  withAccessFetch,
  withoutAccessOriginCookies,
} from './e2e-surface/access-credentials.js';
import { refuseWithoutAccess, withoutAccessHeaders } from './e2e-surface/access-gate.js';
import { ContainersOutbound as ProductionContainersOutbound } from './sandbox-containers/containers-outbound.js';
import type { Env } from './types.js';

// The Worker's own requests to the two Access-protected e2e origins (callback
// delivery to itself, model validation against the fake LLM) carry the service
// token. Wrapped once, at module load; every other request is untouched.
globalThis.fetch = withAccessFetch(globalThis.fetch.bind(globalThis), () => workerEnv);

export { SandboxContainment, SandboxSmallContainment } from './legacy-runtime-tombstones.js';
export { SandboxControlV2 as SandboxControl } from './control-plane/sandbox/sandbox-do.js';
export { SandboxSessionV2 as SandboxSession } from './control-plane/session/session-do.js';
export { CloudAgentWorkspaceDO as CloudAgentWorkspace } from './control-plane/workspace/workspace-do.js';
export { SandboxContainers } from './sandbox-containers/SandboxContainers.js';
export { StreamTicketNonceDO } from './persistence/StreamTicketNonceDO.js';
export { EnvironmentBuild } from './environment-build/environment-build-do.js';
export { VercelSnapshotBuild } from './persistence/VercelSnapshotBuild.js';
export { UserKiloFacade } from './kilo-facade/user-kilo-facade.js';
export { PreviewTunnel } from './preview-tunnel/preview-tunnel-do.js';
export { E2eCallbackSink } from './persistence/E2eCallbackSink.js';

/**
 * Container egress with the e2e Worker's Access service token on requests to
 * the two e2e origins, and without any cookie those responses set.
 * `SandboxContainers` installs `ctx.exports.ContainersOutbound` as the outbound
 * handler, so this export replaces production's only in the e2e Worker. Every
 * other destination is forwarded unchanged.
 */
export class ContainersOutbound extends ProductionContainersOutbound {
  override async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(withAccessCredentials(request, this.env));
    return withoutAccessOriginCookies(request, response, this.env);
  }
}

function isE2eSurfacePath(pathname: string): boolean {
  return pathname === '/__e2e' || pathname.startsWith('/__e2e/');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const refusal = await refuseWithoutAccess(request, env);
    if (refusal !== null) return refusal;
    // Nothing behind the gate sees the service token or the assertion.
    const admitted = withoutAccessHeaders(request);
    const url = new URL(admitted.url);
    if (isE2eSurfacePath(url.pathname)) {
      return e2eSurfaceApp.fetch(admitted, env, ctx);
    }
    return production.fetch(admitted, env, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    return production.queue(batch, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return production.scheduled(controller, env, ctx);
  },
};
