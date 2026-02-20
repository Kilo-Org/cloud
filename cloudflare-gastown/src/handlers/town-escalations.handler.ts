import type { Context } from 'hono';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

export async function handleListEscalations(c: Context<GastownEnv>, params: { townId: string }) {
  const acknowledged = c.req.query('acknowledged');
  const filter = acknowledged !== undefined ? { acknowledged: acknowledged === 'true' } : undefined;

  const townDO = getTownDOStub(c.env, params.townId);
  const escalations = await townDO.listEscalations(filter);
  return c.json(resSuccess(escalations));
}

export async function handleAcknowledgeEscalation(
  c: Context<GastownEnv>,
  params: { townId: string; escalationId: string }
) {
  const townDO = getTownDOStub(c.env, params.townId);
  const escalation = await townDO.acknowledgeEscalation(params.escalationId);
  if (!escalation) return c.json(resError('Escalation not found'), 404);
  return c.json(resSuccess(escalation));
}
