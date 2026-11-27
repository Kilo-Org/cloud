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

import production from './index.js';
import { e2eSurfaceApp } from './e2e-surface/app.js';
import {
  withoutSelfOriginCookies,
  withSelfAccessCredentials,
} from './e2e-surface/access-credentials.js';
import { refuseWithoutAccess } from './e2e-surface/access-gate.js';
import { ContainersOutbound as ProductionContainersOutbound } from './sandbox-containers/containers-outbound.js';
import type { Env } from './types.js';

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
 * its own origin, and without any cookie those responses set. `SandboxContainers`
 * installs `ctx.exports.ContainersOutbound` as the outbound handler, so this
 * export replaces production's only in the e2e Worker. Every other destination
 * is forwarded unchanged.
 */
export class ContainersOutbound extends ProductionContainersOutbound {
  override async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(withSelfAccessCredentials(request, this.env));
    return withoutSelfOriginCookies(request, response, this.env);
  }
}

function isE2eSurfacePath(pathname: string): boolean {
  return pathname === '/__e2e' || pathname.startsWith('/__e2e/');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const refusal = await refuseWithoutAccess(request, env);
    if (refusal !== null) return refusal;
    const url = new URL(request.url);
    if (isE2eSurfacePath(url.pathname)) {
      return e2eSurfaceApp.fetch(request, env, ctx);
    }
    return production.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    return production.queue(batch, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return production.scheduled(controller, env, ctx);
  },
};
