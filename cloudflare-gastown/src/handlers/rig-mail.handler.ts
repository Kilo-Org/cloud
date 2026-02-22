import type { Context } from 'hono';
import { z } from 'zod';
import { getTownDOStub } from '../dos/Town.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getEnforcedAgentId, getTownId } from '../middleware/auth.middleware';
import type { GastownEnv } from '../gastown.worker';

const SendMailBody = z.object({
  from_agent_id: z.string().min(1),
  to_agent_id: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export async function handleSendMail(c: Context<GastownEnv>, params: { rigId: string }) {
  const parsed = SendMailBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const enforced = getEnforcedAgentId(c);
  if (enforced && enforced !== parsed.data.from_agent_id) {
    return c.json(resError('from_agent_id does not match authenticated agent'), 403);
  }
  const townId = getTownId(c);
  if (!townId) return c.json(resError('Missing townId'), 400);
  const town = getTownDOStub(c.env, townId);
  await town.sendMail(parsed.data);
  return c.json(resSuccess({ sent: true }), 201);
}
