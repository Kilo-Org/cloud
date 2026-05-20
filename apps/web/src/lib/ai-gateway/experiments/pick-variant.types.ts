import type { ModelExperiment } from '@kilocode/db/schema';
import type { EncryptedData } from '@/lib/ai-gateway/byok/encryption';
import type { ResolvedExperimentUpstream } from '@/lib/ai-gateway/experiments/build-direct-provider';
import type { ExperimentUpstream } from '@/lib/ai-gateway/experiments/upstream-schema';

export type ExperimentStatus = 'active' | 'paused';

/**
 * Per-variant payload cached in Redis.
 *
 * The api key is stored ENCRYPTED — the cache never holds plaintext.
 * Decryption happens once per request, only on the chosen variant, inside
 * `pickModelExperimentVariant`. This keeps `BYOK_ENCRYPTION_KEY` rotation
 * effective immediately (no 10-minute "plaintext lives in Redis" window)
 * and limits the blast radius of a Redis dump.
 */
export type CachedVariant = {
  variantId: string;
  weight: number;
  variantVersionId: string;
  upstream: ExperimentUpstream;
  encryptedApiKey: EncryptedData;
};

export type CachedExperiment = {
  experimentId: string;
  publicModelId: string;
  status: ExperimentStatus;
  variants: CachedVariant[];
};

export type ResolveResult =
  | { kind: 'experiment'; experiment: CachedExperiment }
  | { kind: 'none' }
  | { kind: 'unavailable' };

export type AllocationSubject = 'user' | 'machine' | 'ip';

export type PickVariantInput = {
  publicModelId: string;
  userId: string | null;
  machineId: string | null;
  clientIp: string | null;
};

export type PickVariantResult =
  | {
      status: 'active';
      experimentId: string;
      variantId: string;
      variantVersionId: string;
      upstream: ResolvedExperimentUpstream;
      allocationSubject: AllocationSubject;
    }
  | { status: 'not-found' }
  | { status: 'unavailable' };

export type SerializedCachedExperiment = {
  kind: 'experiment';
  experimentId: string;
  publicModelId: string;
  status: ExperimentStatus;
  variants: CachedVariant[];
};

export type SerializedCacheEntry = SerializedCachedExperiment | { kind: 'none' };

export type { ModelExperiment };
