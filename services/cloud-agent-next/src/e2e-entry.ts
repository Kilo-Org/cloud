/**
 * e2e-only Worker entrypoint.
 *
 * It mounts the `/__e2e/*` inspect surface and otherwise forwards every request
 * (and queue/scheduled event) to the production Worker unchanged. Production
 * keeps `main = src/index.ts`; this file is referenced only by the rendered e2e
 * config and the dedicated Workers test config, so no production route,
 * dependency or secret changes and the surface is unreachable on the production
 * Worker by construction.
 */

import production from './index.js';
import { e2eSurfaceApp } from './e2e-surface/app.js';
import type { Env } from './types.js';

export {
  Sandbox,
  SandboxContainment,
  SandboxSmall,
  SandboxSmallContainment,
  SandboxDIND,
  SandboxCodeReview,
  SandboxCodeReviewContainment,
  ContainerProxy,
} from './sandbox-outbound.js';
export { CloudAgentSession } from './persistence/CloudAgentSession.js';
export { SandboxControl } from './persistence/SandboxControl.js';
export { SandboxSession } from './sandbox-session/SandboxSession.js';
export { StreamTicketNonceDO } from './persistence/StreamTicketNonceDO.js';
export { UserKiloFacade } from './kilo-facade/user-kilo-facade.js';
export { E2eCallbackSink } from './persistence/E2eCallbackSink.js';

function isE2eSurfacePath(pathname: string): boolean {
  return pathname === '/__e2e' || pathname.startsWith('/__e2e/');
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    if (isE2eSurfacePath(url.pathname)) {
      return e2eSurfaceApp.fetch(request, env, ctx);
    }
    return production.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    return production.queue(batch, env);
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    return production.scheduled(controller, env);
  },
};
