import type { Context } from 'hono';
import { getRigDOStub } from '../dos/Rig.do';
import { resSuccess } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

export async function handleListBeadEvents(c: Context<GastownEnv>, params: { rigId: string }) {
  const since = c.req.query('since') ?? undefined;
  const beadId = c.req.query('bead_id') ?? undefined;
  const limitStr = c.req.query('limit');
  const limit = limitStr ? parseInt(limitStr, 10) || undefined : undefined;

  const rig = getRigDOStub(c.env, params.rigId);
  const events = await rig.listBeadEvents({ beadId, since, limit });
  return c.json(resSuccess(events));
}
