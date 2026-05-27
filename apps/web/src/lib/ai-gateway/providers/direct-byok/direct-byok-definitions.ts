import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import byteplusCoding from './byteplus-coding';
import chutesByok from './chutes-byok';
import kimiCoding from './kimi-coding';
import neuralwatt from './neurowatt';
import ollamaCloud from './ollama-cloud';
import xiaomiTokenPlanAms from './xiaomi-token-plan-ams';
import xiaomiTokenPlanSgp from './xiaomi-token-plan-sgp';
import zaiCoding from './zai-coding';

export default [
  byteplusCoding,
  chutesByok,
  kimiCoding,
  neuralwatt,
  ollamaCloud,
  xiaomiTokenPlanAms,
  xiaomiTokenPlanSgp,
  zaiCoding,
] satisfies ReadonlyArray<DirectByokProvider>;
