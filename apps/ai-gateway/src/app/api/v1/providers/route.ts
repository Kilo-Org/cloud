import { handleProvidersRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/providers';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { withReplicaAffinity } from '../with-replica-affinity';

export const GET = withReplicaAffinity(withRestTiming('/api/v1/providers', handleProvidersRequest));
