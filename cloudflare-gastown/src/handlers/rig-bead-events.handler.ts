import type { Context } from 'hono';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { getTownId } from '../middleware/auth.middleware';
import type { GastownEnv } from '../gastown.worker';

export async function handleListBeadEvents(c: Context<GastownEnv>, params: { rigId: string }) {
  const since = c.req.query('since') ?? undefined;
  const beadId = c.req.query('bead_id') ?? undefined;
  const limitStr = c.req.query('limit');
  const limit = limitStr ? parseInt(limitStr, 10) || undefined : undefined;

  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  const events = await town.listBeadEvents({ beadId, since, limit });
  return c.json(resSuccess(events));
}
