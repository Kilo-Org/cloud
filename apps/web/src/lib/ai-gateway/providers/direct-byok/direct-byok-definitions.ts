import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import byteplusCoding from './byteplus-coding';
import kimiCoding from './kimi-coding';
import neuralwatt from './neurowatt';
import ollamaCloud from './ollama-cloud';
import zaiCoding from './zai-coding';

export default [
  byteplusCoding,
  kimiCoding,
  neuralwatt,
  ollamaCloud,
  zaiCoding,
] satisfies ReadonlyArray<DirectByokProvider>;
