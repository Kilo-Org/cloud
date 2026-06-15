import { classifyWithOpenRouter } from '@kilocode/auto-routing-contracts/classifier';
import type {
  ClassifierCallOptions,
  ClassifierRunResult,
} from '@kilocode/auto-routing-contracts/classifier';
import type { NormalizedClassifierInput } from '@kilocode/auto-routing-contracts';
import { createOpenRouterClient } from './openrouter';

export {
  ClassifierRunError,
  classifyWithOpenRouter,
} from '@kilocode/auto-routing-contracts/classifier';
export type {
  ClassifierCallOptions,
  ClassifierRunResult,
} from '@kilocode/auto-routing-contracts/classifier';

type ClassifierEnv = Pick<Env, 'OPENROUTER_API_KEY'>;

export async function classifyNormalizedInput(
  env: ClassifierEnv,
  input: NormalizedClassifierInput,
  classifierModel: string,
  options: ClassifierCallOptions = {}
): Promise<ClassifierRunResult> {
  const client = await createOpenRouterClient(env);
  return classifyWithOpenRouter(client, input, classifierModel, options);
}
