import type { Context } from 'hono';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

export async function handleListBeadEvents(c: Context<GastownEnv>, _params: { rigId: string }) {
  const since = c.req.query('since') ?? undefined;
  const beadId = c.req.query('bead_id') ?? undefined;
  const limitStr = c.req.query('limit');
  const parsedLimit = limitStr !== undefined ? Number(limitStr) : undefined;
  const limit =
    parsedLimit !== undefined && Number.isInteger(parsedLimit) && parsedLimit >= 0
      ? parsedLimit
      : undefined;

  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC stub returns Rpc.Promisified
  const events = await town.listBeadEvents({ beadId, since, limit });
  return c.json(resSuccess(events));
}
