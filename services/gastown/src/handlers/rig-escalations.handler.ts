import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { BeadPriority } from '../types';
import type { GastownEnv } from '../gastown.worker';

const CreateEscalationBody = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  priority: BeadPriority.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function handleCreateEscalation(c: Context<GastownEnv>, params: { rigId: string }) {
  const parsed = CreateEscalationBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const townId = c.get('townId');
  const town = getTownDOStub(c.env, townId);
  const escalation = await town.routeEscalation({
    townId,
    source_rig_id: params.rigId,
    severity: parsed.data.priority ?? 'medium',
    message: parsed.data.title,
    category: undefined,
    source_agent_id: undefined,
  });
  return c.json(resSuccess(escalation), 201);
}
