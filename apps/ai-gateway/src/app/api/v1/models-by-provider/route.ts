import { handleModelsByProviderRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/models-by-provider';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { withReplicaAffinity } from '../with-replica-affinity';

export const GET = withReplicaAffinity(
  withRestTiming('/api/v1/models-by-provider', handleModelsByProviderRequest)
);
