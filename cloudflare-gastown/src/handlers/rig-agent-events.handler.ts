import type { Context } from 'hono';
import { z } from 'zod';
import { getRigDOStub } from '../dos/Rig.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { GastownEnv } from '../gastown.worker';

const AppendEventBody = z.object({
  agent_id: z.string().min(1),
  event_type: z.string().min(1),
  data: z.unknown().default({}),
});

/**
 * Append an event to the agent's persistent event log.
 * Called by the container (via completion-reporter or a streaming relay)
 * to persist events so late-joining dashboard clients can catch up.
 */
export async function handleAppendAgentEvent(c: Context<GastownEnv>, params: { rigId: string }) {
  const parsed = AppendEventBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(resError('Invalid request body'), 400);
  }

  const rig = getRigDOStub(c.env, params.rigId);
  await rig.appendAgentEvent(parsed.data.agent_id, parsed.data.event_type, parsed.data.data);
  return c.json(resSuccess({ appended: true }), 201);
}

/**
 * Get agent events from the persistent log, optionally after a given event id.
 * Used by the frontend to catch up on events that happened before the
 * WebSocket connection was established.
 */
export async function handleGetAgentEvents(
  c: Context<GastownEnv>,
  params: { rigId: string; agentId: string }
) {
  const afterId = c.req.query('after_id');
  const limit = c.req.query('limit');

  const rig = getRigDOStub(c.env, params.rigId);
  const events = await rig.getAgentEvents(
    params.agentId,
    afterId ? Number(afterId) : undefined,
    limit ? Number(limit) : undefined
  );

  return c.json(resSuccess(events));
}
