import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import byteplusCoding from './byteplus-coding';
import chutes from './chutes';
import kimiCoding from './kimi-coding';
import nanoGpt from './nano-gpt';
import neuralwatt from './neurowatt';
import zaiCoding from './zai-coding';

export default [
  byteplusCoding,
  chutes,
  kimiCoding,
  nanoGpt,
  neuralwatt,
  zaiCoding,
] satisfies ReadonlyArray<DirectByokProvider>;
