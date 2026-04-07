import type { DirectByokProvider } from '@/lib/providers/direct-byok/types';
import byteplusCodingModels from './byteplus-coding-models';
import kimiCodingModels from './kimi-coding-models';
import neuralwattModels from './neurowatt-models';
import zaiCodingModels from './zai-coding-models';

export default [byteplusCodingModels, kimiCodingModels, neuralwattModels, zaiCodingModels] satisfies ReadonlyArray<DirectByokProvider>;
