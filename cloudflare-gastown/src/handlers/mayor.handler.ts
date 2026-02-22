import type { Context } from 'hono';
import { z } from 'zod';
import type { GastownEnv } from '../gastown.worker';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';

const MAYOR_HANDLER_LOG = '[mayor.handler]';

const SendMayorMessageBody = z.object({
  message: z.string().min(1),
  model: z.string().optional(),
});

const MayorCompletedBody = z.object({
  status: z.enum(['completed', 'failed']),
  reason: z.string().optional(),
  agentId: z.string().optional(),
});

/**
 * POST /api/towns/:townId/mayor/configure
 * Configure the MayorDO for a town. Called when a rig is created.
 */
export async function handleConfigureMayor(c: Context<GastownEnv>, params: { townId: string }) {
  // No-op: the mayor auto-configures on first message via TownDO.
  console.log(`${MAYOR_HANDLER_LOG} handleConfigureMayor: no-op for townId=${params.townId}`);
  return c.json(resSuccess({ configured: true }), 200);
}

/**
 * POST /api/towns/:townId/mayor/message
 * Send a user message to the mayor. Creates session on first call,
 * sends follow-up on subsequent calls. No beads are created.
 */
export async function handleSendMayorMessage(c: Context<GastownEnv>, params: { townId: string }) {
  const body = await parseJsonBody(c);
  const parsed = SendMayorMessageBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${MAYOR_HANDLER_LOG} handleSendMayorMessage: townId=${params.townId} message="${parsed.data.message.slice(0, 80)}"`
  );

  const town = getTownDOStub(c.env, params.townId);
  // Ensure the TownDO knows its real UUID (ctx.id.name is unreliable in local dev)
  // TODO: This should only be done on town creation. Why are we doing it here?
  await town.setTownId(params.townId);
  const result = await town.sendMayorMessage(parsed.data.message, parsed.data.model);
  return c.json(resSuccess(result), 200);
}

/**
 * GET /api/towns/:townId/mayor/status
 * Get the mayor's session status.
 */
export async function handleGetMayorStatus(c: Context<GastownEnv>, params: { townId: string }) {
  const town = getTownDOStub(c.env, params.townId);
  await town.setTownId(params.townId);
  const status = await town.getMayorStatus();
  return c.json(resSuccess(status), 200);
}

/**
 * POST /api/towns/:townId/mayor/completed
 * Completion callback from the container. Clears the session immediately
 * so the UI reflects idle status without waiting for the alarm.
 */
export async function handleMayorCompleted(c: Context<GastownEnv>, params: { townId: string }) {
  const body = await parseJsonBody(c);
  const parsed = MayorCompletedBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${MAYOR_HANDLER_LOG} handleMayorCompleted: townId=${params.townId} status=${parsed.data.status}`
  );

  const town = getTownDOStub(c.env, params.townId);
  await town.agentCompleted(parsed.data.agentId ?? '', {
    status: parsed.data.status,
    reason: parsed.data.reason,
  });
  return c.json(resSuccess({ acknowledged: true }), 200);
}

/**
 * POST /api/towns/:townId/mayor/destroy
 * Tear down the mayor session and clear all state.
 */
export async function handleDestroyMayor(c: Context<GastownEnv>, params: { townId: string }) {
  // No-op: we don't want to destroy the entire town from this endpoint.
  console.log(`${MAYOR_HANDLER_LOG} handleDestroyMayor: no-op for townId=${params.townId}`);
  return c.json(resSuccess({ destroyed: true }), 200);
}
