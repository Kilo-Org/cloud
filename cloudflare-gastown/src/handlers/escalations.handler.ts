import type { Context } from 'hono';
import { z } from 'zod';
import { getRigDOStub } from '../dos/Rig.do';
import { resSuccess } from '../util/res.util';
import { BeadPriority } from '../types';
import type { GastownEnv } from '../gastown.worker';

const CreateEscalationBody = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  priority: BeadPriority.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function handleCreateEscalation(c: Context<GastownEnv>, params: { rigId: string }) {
  const parsed = CreateEscalationBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const rig = getRigDOStub(c.env, params.rigId);
  const bead = await rig.createBead({
    type: 'escalation',
    title: parsed.data.title,
    body: parsed.data.body,
    priority: parsed.data.priority,
    metadata: parsed.data.metadata,
  });
  return c.json(resSuccess(bead), 201);
}
