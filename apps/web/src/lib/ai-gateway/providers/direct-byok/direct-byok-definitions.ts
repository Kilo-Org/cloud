import type { DirectByokProvider } from './types';
import byteplusCoding from './byteplus-coding';
import chutesByok from './chutes-byok';
import kimiCoding from './kimi-coding';
import neuralwatt from './neurowatt';
import ollamaCloud from './ollama-cloud';
import xiaomiTokenPlanAms from './xiaomi-token-plan-ams';
import xiaomiTokenPlanSgp from './xiaomi-token-plan-sgp';
import zaiCoding from './zai-coding';
import crofai from './crofai';
import martian from './martian';
import orcarouter from './orcarouter';
import synthetic from './synthetic';

export default [
  byteplusCoding,
  chutesByok,
  crofai,
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
