import type { Handler } from 'hono';
import * as z from 'zod';
import { DEFAULT_CLASSIFIER_MODEL } from './classifier-prompt';
import { getClassifierModel, setClassifierModel } from './classifier-config';
import type { HonoEnv } from './hono-env';

const updateClassifierModelSchema = z.object({
  model: z.string().trim().min(1),
});

function classifierModelResponse(model: string) {
  return {
    model,
    defaultModel: DEFAULT_CLASSIFIER_MODEL,
  };
}

export const getClassifierModelHandler: Handler<HonoEnv> = async c => {
  const model = await getClassifierModel(c.env);
  return c.json(classifierModelResponse(model));
};

export const putClassifierModelHandler: Handler<HonoEnv> = async c => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = updateClassifierModelSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid classifier model' }, 400);
  }

  const model = await setClassifierModel(c.env, parsed.data.model);
  if (!model) {
    return c.json({ error: 'Invalid classifier model' }, 400);
  }

  return c.json(classifierModelResponse(model));
};
