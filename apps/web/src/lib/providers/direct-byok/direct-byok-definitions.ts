import type { DirectByokProvider } from '@/lib/providers/direct-byok/types';
import byteplusCoding from './byteplus-coding';
import kimiCoding from './kimi-coding';
import neuralwatt from './neurowatt';
import zaiCoding from './zai-coding';

export default [
  byteplusCoding,
  kimiCoding,
  neuralwatt,
  zaiCoding,
] satisfies ReadonlyArray<DirectByokProvider>;
