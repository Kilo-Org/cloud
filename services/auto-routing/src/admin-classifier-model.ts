import {
  UpdateClassifierModelRequestSchema,
  type AutoRoutingClassifierModelResponse,
} from '@kilocode/auto-routing-contracts';
import type { Handler } from 'hono';
import { DEFAULT_CLASSIFIER_MODEL } from './classifier-prompt';
import { getClassifierModel, setClassifierModel } from './classifier-config';
import type { HonoEnv } from './hono-env';

function classifierModelResponse(model: string): AutoRoutingClassifierModelResponse {
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

  const parsed = UpdateClassifierModelRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid classifier model' }, 400);
  }

  const model = await setClassifierModel(c.env, parsed.data.model);
  if (!model) {
    return c.json({ error: 'Invalid classifier model' }, 400);
  }

  return c.json(classifierModelResponse(model));
};
