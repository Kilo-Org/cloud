import type { ModelExperiment } from '@kilocode/db/schema';
import type { EncryptedData } from '@/lib/ai-gateway/byok/encryption';
import type { ResolvedExperimentUpstream } from '@/lib/ai-gateway/experiments/build-direct-provider';
import type { ExperimentUpstream } from '@/lib/ai-gateway/experiments/upstream-schema';

export type ExperimentStatus = 'active' | 'paused';

export type RoutingVariant = {
  variantId: string;
  weight: number;
  variantVersionId: string;
  upstream: ExperimentUpstream;
  encryptedApiKey: EncryptedData;
};

export type RoutingExperiment = {
  experimentId: string;
  publicModelId: string;
  status: ExperimentStatus;
  variants: RoutingVariant[];
};

export type ResolveResult =
  | { kind: 'experiment'; experiment: RoutingExperiment }
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

export type { ModelExperiment };
