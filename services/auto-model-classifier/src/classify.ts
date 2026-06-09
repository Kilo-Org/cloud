import type { Handler } from 'hono';
import { mirrorPayloadSchema, parseClassifierInput } from './classifier-input';
import { classifyNormalizedInput } from './model-classifier';
import type { HonoEnv } from './hono-env';

export const classifyHandler: Handler<HonoEnv> = async c => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = mirrorPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid classifier payload' }, 400);
  }

  const classifierInput = parseClassifierInput(parsed.data);
  if (!classifierInput.success) {
    return c.json({ error: classifierInput.error }, 400);
  }

  try {
    const classification = await classifyNormalizedInput(c.env, classifierInput.data);
    return c.json({ ok: true, classification, normalized: classifierInput.data });
  } catch {
    return c.json({ error: 'Classifier model request failed' }, 502);
  }
};
