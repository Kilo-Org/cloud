import type { Context } from 'hono';
import { getRigDOStub } from '../dos/Rig.do';

/**
 * Resolves the Rig DO stub for the current request's :rigId param.
 * The rigId comes from the parent route `/api/rigs/:rigId/...`, which Hono
 * makes available even inside mounted sub-routers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRigStubFromContext(c: Context<any>) {
  const rigId = c.req.param('rigId');
  if (!rigId) throw new Error('Missing rigId route parameter');
  return getRigDOStub(c.env, rigId);
}
