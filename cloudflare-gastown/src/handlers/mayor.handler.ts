import type { Context } from 'hono';
import { z } from 'zod';
import type { GastownEnv } from '../gastown.worker';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { UiActionSchema, normalizeUiAction, uiActionRigId } from '../types';

const MAYOR_HANDLER_LOG = '[mayor.handler]';

const SendMayorMessageBody = z.object({
  message: z.string().min(1),
  model: z.string().optional(),
  uiContext: z.string().max(10_000).optional(),
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
  const result = await town.sendMayorMessage(
    parsed.data.message,
    parsed.data.model,
    parsed.data.uiContext
  );
  return c.json(resSuccess(result), 200);
}

/**
 * GET /api/towns/:townId/mayor/status
 * Get the mayor's session status.
 */
export async function handleGetMayorStatus(c: Context<GastownEnv>, params: { townId: string }) {
  const town = getTownDOStub(c.env, params.townId);
  const status = await town.getMayorStatus();
  return c.json(resSuccess(status), 200);
}

/**
 * POST /api/towns/:townId/mayor/ensure
 * Eagerly ensure the mayor agent + container are running.
 * Called on page load so the terminal is available immediately.
 */
export async function handleEnsureMayor(c: Context<GastownEnv>, params: { townId: string }) {
  console.log(`${MAYOR_HANDLER_LOG} handleEnsureMayor: townId=${params.townId}`);
  const town = getTownDOStub(c.env, params.townId);
  const result = await town.ensureMayor();
  return c.json(resSuccess(result), 200);
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
 * Tear down the mayor agent and its container session. Does NOT destroy
 * the town — only removes the mayor agent so it can be re-created.
 */
export async function handleDestroyMayor(c: Context<GastownEnv>, params: { townId: string }) {
  console.log(
    `${MAYOR_HANDLER_LOG} handleDestroyMayor: destroying mayor for townId=${params.townId}`
  );
  const town = getTownDOStub(c.env, params.townId);
  const status = await town.getMayorStatus();
  if (status.session) {
    await town.deleteAgent(status.session.agentId);
  }
  return c.json(resSuccess({ destroyed: true }), 200);
}

const SetDashboardContextBody = z.object({
  context: z.string().max(10_000),
});

const BroadcastUiActionBody = z.object({
  action: UiActionSchema,
});

/**
 * POST /api/towns/:townId/mayor/dashboard-context
 * Store the current dashboard context (XML string) in the TownDO.
 * Used as a fallback when sendMayorMessage is called without explicit uiContext.
 */
export async function handleSetDashboardContext(
  c: Context<GastownEnv>,
  params: { townId: string }
) {
  const body = await parseJsonBody(c);
  const parsed = SetDashboardContextBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const town = getTownDOStub(c.env, params.townId);
  await town.setDashboardContext(parsed.data.context);
  return c.json(resSuccess({ stored: true }), 200);
}

/**
 * POST /api/towns/:townId/mayor/ui-action
 * Broadcast a UI action to all connected dashboard WebSocket clients.
 * Called by the mayor agent to trigger navigation/drawer actions in the dashboard.
 * Protected by kiloAuthMiddleware (same as other /api/towns/:townId/mayor/* routes).
 */
export async function handleBroadcastUiAction(c: Context<GastownEnv>, params: { townId: string }) {
  const body = await parseJsonBody(c);
  const parsed = BroadcastUiActionBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${MAYOR_HANDLER_LOG} handleBroadcastUiAction: townId=${params.townId} type=${parsed.data.action.type}`
  );

  const action = normalizeUiAction(parsed.data.action, params.townId);

  const town = getTownDOStub(c.env, params.townId);

  // Validate that the referenced rig belongs to this town
  const rigId = uiActionRigId(action);
  if (rigId) {
    const rig = await town.getRigAsync(rigId);
    if (!rig) {
      return c.json({ success: false, error: `Rig ${rigId} does not belong to this town` }, 400);
    }
  }

  await town.broadcastUiAction(action);
  return c.json(resSuccess({ broadcast: true }), 200);
}
