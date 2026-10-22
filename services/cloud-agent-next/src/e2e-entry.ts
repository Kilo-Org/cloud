/**
 * e2e-only Worker entrypoint.
 *
 * It mounts the `/__e2e/*` inspect surface, requires the e2e key for the
 * session-start procedures when the render enables that gate, and otherwise
 * forwards every request (and queue/scheduled event) to the production Worker
 * unchanged. Production keeps `main = src/index.ts`; this file is referenced
 * only by the rendered e2e config and the dedicated Workers test config, so no
 * production route, dependency or secret changes and the surface is unreachable
 * on the production Worker by construction.
 */

import { timingSafeEqual } from '@kilocode/encryption';
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
export { SandboxControlV2 as SandboxControl } from './control-plane/sandbox/sandbox-do.js';
export { SandboxSessionV2 as SandboxSession } from './control-plane/session/session-do.js';
export { StreamTicketNonceDO } from './persistence/StreamTicketNonceDO.js';
export { UserKiloFacade } from './kilo-facade/user-kilo-facade.js';
export { E2eCallbackSink } from './persistence/E2eCallbackSink.js';

const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';

/**
 * Every user-token procedure that can start a session's container: the two
 * creation routes, and the three that enqueue work whose alarm-driven flusher
 * starts or restores the sandbox for an existing session. `prepareSession` is
 * already behind `internalApiProtectedProcedure` (secret plus token), so it
 * needs no entry here.
 */
const SESSION_START_PROCEDURES: Record<string, true> = {
  start: true,
  createWorktreeChat: true,
  send: true,
  sendMessageV2: true,
  initiateFromKilocodeSessionV2: true,
};

function isE2eSurfacePath(pathname: string): boolean {
  return pathname === '/__e2e' || pathname.startsWith('/__e2e/');
}

/**
 * A tRPC mutation path carries one procedure, or a comma-separated batch of
 * them; any session-start member of the batch makes the request a session
 * start. Only POST can invoke a mutation, so GET queries stay outside the gate.
 */
export function isSessionStartRequest(method: string, pathname: string): boolean {
  if (method !== 'POST' || !pathname.startsWith('/trpc/')) return false;
  return pathname
    .slice('/trpc/'.length)
    .split(',')
    .some(procedure => SESSION_START_PROCEDURES[procedure] === true);
}

/**
 * The admission gate for the rendered e2e Worker. It is active only when
 * `E2E_SESSION_ADMISSION` names the credential, and only the deployed render
 * (which is addressed publicly) writes that var; local renders keep it unset so
 * the local web app, which presents its own internal secret, is unaffected.
 *
 * The presented value is compared with the e2e-scoped `INTERNAL_API_SECRET` —
 * the same secret the `/__e2e/*` surface and the internal procedures use — in
 * constant time. An unset or empty binding fails closed, and the check runs
 * before the production app, so no token verification, balance check or
 * Hyperdrive dereference happens for a request that cannot be admitted.
 */
export function admitSessionStart(request: Request, env: Env): Response | null {
  if (env.E2E_SESSION_ADMISSION !== 'internal-key') return null;
  const expected = env.INTERNAL_API_SECRET;
  const presented = request.headers.get(INTERNAL_API_KEY_HEADER);
  if (!expected || !presented || !timingSafeEqual(presented, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }
  return null;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    if (isE2eSurfacePath(url.pathname)) {
      return e2eSurfaceApp.fetch(request, env, ctx);
    }
    if (isSessionStartRequest(request.method, url.pathname)) {
      const denial = admitSessionStart(request, env);
      if (denial) return denial;
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
