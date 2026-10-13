import { classifyWithSystemOne } from '@kilocode/auto-routing-contracts/classifier';
import type { ClassifierRunResult } from '@kilocode/auto-routing-contracts/classifier';
import type { NormalizedClassifierInput } from '@kilocode/auto-routing-contracts';
import { createSystemOneClient } from './openrouter';

export { ClassifierRunError } from '@kilocode/auto-routing-contracts/classifier';
export type { ClassifierRunResult } from '@kilocode/auto-routing-contracts/classifier';

type ClassifierEnv = Pick<Env, 'OPENROUTER_API_KEY'>;

export async function classifyNormalizedInput(
  env: ClassifierEnv,
  input: NormalizedClassifierInput,
  classifierModel: string
): Promise<ClassifierRunResult> {
  const client = await createSystemOneClient(env);
  return classifyWithSystemOne(client, input, classifierModel);
}
