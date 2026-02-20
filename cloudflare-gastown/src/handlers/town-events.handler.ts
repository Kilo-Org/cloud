import type { Context } from 'hono';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

/**
 * List bead events for a town. Since all data lives in the Town DO now,
 * this is a single call rather than a fan-out across Rig DOs.
 * GET /api/users/:userId/towns/:townId/events?since=<iso>&limit=<n>
 */
export async function handleListTownEvents(
  c: Context<GastownEnv>,
  params: { userId: string; townId: string }
) {
  const since = c.req.query('since') ?? undefined;
  const limitStr = c.req.query('limit');
  const limit = limitStr ? parseInt(limitStr, 10) || 100 : 100;

  const town = getTownDOStub(c.env, params.townId);
  const events = await town.listBeadEvents({ since, limit });

  return c.json(resSuccess(events));
}
