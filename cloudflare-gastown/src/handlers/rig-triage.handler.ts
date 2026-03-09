import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getEnforcedAgentId } from '../middleware/auth.middleware';
import type { GastownEnv } from '../gastown.worker';

const VALID_TRIAGE_ACTIONS = [
  'RESTART',
  'RESTART_WITH_BACKOFF',
  'CLOSE_BEAD',
  'ESCALATE',
  'ESCALATE_TO_MAYOR',
  'NUDGE',
  'REASSIGN_BEAD',
  'DISCARD',
  'PROVIDE_GUIDANCE',
] as const;

const ResolveTriageBody = z.object({
  triage_request_bead_id: z.string().min(1),
  action: z
    .string()
    .min(1)
    .transform(v => v.toUpperCase())
    .pipe(z.enum(VALID_TRIAGE_ACTIONS)),
  resolution_notes: z.string(),
});

export async function handleResolveTriage(c: Context<GastownEnv>, _params: { rigId: string }) {
  const agentId = getEnforcedAgentId(c);
  if (!agentId) {
    return c.json(resError('Agent authentication required'), 401);
  }

  const parsed = ResolveTriageBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);

  // Verify this agent is actually working on a triage batch. Without this
  // check, any rig agent (polecat, refinery) could call the endpoint and
  // trigger restart/close/escalate side effects on other agents.
  const hookedBead = await town.getHookedBead(agentId);
  if (
    !hookedBead ||
    !hookedBead.labels.includes('gt:triage') ||
    hookedBead.created_by !== 'patrol'
  ) {
    return c.json(resError('Only triage agents can resolve triage requests'), 403);
  }

  const bead = await town.resolveTriage({
    agent_id: agentId,
    ...parsed.data,
  });
  return c.json(resSuccess(bead), 200);
}
