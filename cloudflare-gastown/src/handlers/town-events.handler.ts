import type { Context } from 'hono';
import { getGastownUserStub } from '../dos/GastownUser.do';
import { getRigDOStub } from '../dos/Rig.do';
import { resSuccess } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';
import { RigBeadEventRecord as RigBeadEventRecordSchema } from '../db/tables/rig-bead-events.table';
import type { RigBeadEventRecord } from '../db/tables/rig-bead-events.table';
import { UserRigRecord } from '../db/tables/user-rigs.table';

type TaggedBeadEvent = RigBeadEventRecord & { rig_id: string; rig_name: string };

/**
 * Fan out to all Rig DOs in a town and return a merged, sorted event stream.
 * GET /api/users/:userId/towns/:townId/events?since=<iso>&limit=<n>
 */
export async function handleListTownEvents(
  c: Context<GastownEnv>,
  params: { userId: string; townId: string }
) {
  const since = c.req.query('since') ?? undefined;
  const limitStr = c.req.query('limit');
  const limit = limitStr ? parseInt(limitStr, 10) || 100 : 100;

  // Look up all rigs in the town
  const townDO = getGastownUserStub(c.env, params.userId);
  const rigsUnknown: unknown = await townDO.listRigs(params.townId);
  const rigs = UserRigRecord.array().parse(rigsUnknown);

  // Fan out to each Rig DO in parallel
  const eventPromises = rigs.map(async (rig): Promise<TaggedBeadEvent[]> => {
    const rigDO = getRigDOStub(c.env, rig.id);
    const eventsUnknown: unknown = await rigDO.listBeadEvents({ since, limit });
    const events = RigBeadEventRecordSchema.array().parse(eventsUnknown);
    return events.map((e: RigBeadEventRecord) => ({ ...e, rig_id: rig.id, rig_name: rig.name }));
  });

  const results = await Promise.allSettled(eventPromises);
  const allEvents = results
    .filter((r): r is PromiseFulfilledResult<TaggedBeadEvent[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, limit);

  return c.json(resSuccess(allEvents));
}
