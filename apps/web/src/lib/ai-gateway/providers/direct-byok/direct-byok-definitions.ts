import type { DirectByokProvider } from './types';
import byteplusCoding from './byteplus-coding';
import chutesByok from './chutes-byok';
import crofai from './crofai';
import inceptronByok from './inceptron-byok';
import kimiCoding from './kimi-coding';
import martian from './martian';
import neuralwatt from './neurowatt';
import ollamaCloud from './ollama-cloud';
import orcarouter from './orcarouter';
import synthetic from './synthetic';
import xiaomiTokenPlanAms from './xiaomi-token-plan-ams';
import xiaomiTokenPlanSgp from './xiaomi-token-plan-sgp';
import zaiCoding from './zai-coding';

export default [
  byteplusCoding,
  chutesByok,
  crofai,
  inceptronByok,
  kimiCoding,
  martian,
  neuralwatt,
  ollamaCloud,
  orcarouter,
  synthetic,
  xiaomiTokenPlanAms,
  xiaomiTokenPlanSgp,
  zaiCoding,
] satisfies ReadonlyArray<DirectByokProvider>;
