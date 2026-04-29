import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import { DIRECT_BYOK_PROVIDERS_META } from '@/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import byteplusCoding from './byteplus-coding';
import kimiCoding from './kimi-coding';
import neuralwatt from './neurowatt';
import zaiCoding from './zai-coding';

const DIRECT_BYOK_PROVIDERS = [
  byteplusCoding,
  kimiCoding,
  neuralwatt,
  zaiCoding,
] satisfies ReadonlyArray<DirectByokProvider>;

for (const provider of DIRECT_BYOK_PROVIDERS) {
  const meta = DIRECT_BYOK_PROVIDERS_META.find(m => m.id === provider.id);
  if (!meta || meta.name !== provider.name) {
    throw new Error(
      `direct-byok-meta entry for '${provider.id}' is missing or has a mismatched name`
    );
  }
}

export default DIRECT_BYOK_PROVIDERS;
