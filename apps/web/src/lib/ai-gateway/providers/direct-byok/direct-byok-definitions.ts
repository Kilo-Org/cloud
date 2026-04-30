import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import byteplusCoding from './byteplus-coding';
import chutesByok from './chutes-byok';
import kimiCoding from './kimi-coding';
import neuralwatt from './neurowatt';
import ollamaCloud from './ollama-cloud';
import zaiCoding from './zai-coding';

export default [
  byteplusCoding,
  chutesByok,
  kimiCoding,
  neuralwatt,
  ollamaCloud,
  zaiCoding,
] satisfies ReadonlyArray<DirectByokProvider>;
