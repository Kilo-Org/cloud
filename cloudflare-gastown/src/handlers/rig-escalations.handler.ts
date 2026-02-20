import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getTownId } from '../middleware/auth.middleware';
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
  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  const bead = await town.createBead({
    type: 'escalation',
    title: parsed.data.title,
    body: parsed.data.body,
    priority: parsed.data.priority,
    metadata: parsed.data.metadata,
  });
  return c.json(resSuccess(bead), 201);
}
