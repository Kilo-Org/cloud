import {
  UpdateClassifierModelRequestSchema,
  type AutoRoutingClassifierModelResponse,
} from '@kilocode/auto-routing-contracts';
import type { Handler } from 'hono';
import { DEFAULT_CLASSIFIER_MODEL } from '@kilocode/auto-routing-contracts/classifier';
import { getClassifierModelInfo, setClassifierModel } from './classifier-config';
import type { ClassifierModelInfo } from './classifier-config';
import type { HonoEnv } from './hono-env';

function classifierModelResponse(info: ClassifierModelInfo): AutoRoutingClassifierModelResponse {
  return {
    model: info.model,
    override: info.override,
    benchmarkWinner: info.benchmarkWinner,
    defaultModel: DEFAULT_CLASSIFIER_MODEL,
  };
}

export const getClassifierModelHandler: Handler<HonoEnv> = async c => {
  const info = await getClassifierModelInfo(c.env);
  return c.json(classifierModelResponse(info));
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

  const info = await setClassifierModel(c.env, parsed.data.model);
  if (!info) {
    return c.json({ error: 'Invalid classifier model' }, 400);
  }

  return c.json(classifierModelResponse(info));
};
