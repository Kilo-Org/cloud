import type { DirectByokProviderMetaId } from './direct-byok-meta';
import type { DirectByokProvider } from './types';
import alibabaTokenPlan from './alibaba-token-plan';
import bedrockByok from './bedrock-byok';
import byteplusCoding from './byteplus-coding';
import chutesByok from './chutes-byok';
import edenai from './edenai';
import inceptronByok from './inceptron-byok';
import kimiCoding from './kimi-coding';
import martian from './martian';
import morph from './morph';
import neuralwatt from './neurowatt';
import nvidiaByok from './nvidia-byok';
import ollamaCloud from './ollama-cloud';
import openCodeGo from './opencode-go';
import orcarouter from './orcarouter';
import synthetic from './synthetic';
import vertexByok from './vertex-byok';
import xiaomiTokenPlanAms from './xiaomi-token-plan-ams';
import xiaomiTokenPlanSgp from './xiaomi-token-plan-sgp';
import zaiCoding from './zai-coding';

/** Fails to compile with the offending type when `T` is not `never`. */
export type AssertNever<T extends never> = T;

const DIRECT_BYOK_PROVIDERS = [
  alibabaTokenPlan,
  bedrockByok,
  byteplusCoding,
  chutesByok,
  edenai,
  inceptronByok,
  kimiCoding,
  martian,
  morph,
  neuralwatt,
  nvidiaByok,
  ollamaCloud,
  openCodeGo,
  orcarouter,
  synthetic,
  vertexByok,
  xiaomiTokenPlanAms,
  xiaomiTokenPlanSgp,
  zaiCoding,
] satisfies ReadonlyArray<DirectByokProvider>;

/** A provider the shared metadata names without a definition; such a provider cannot be used. */
type UndefinedDirectByokProviderId = Exclude<
  DirectByokProviderMetaId,
  (typeof DIRECT_BYOK_PROVIDERS)[number]['id']
>;

export type EveryDirectByokProviderHasDefinition = AssertNever<UndefinedDirectByokProviderId>;

export default DIRECT_BYOK_PROVIDERS;
