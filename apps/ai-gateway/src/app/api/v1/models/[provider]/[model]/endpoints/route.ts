import { handleModelEndpointsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/model-endpoints';
import { withReplicaAffinity } from '../../../../with-replica-affinity';

export const GET = withReplicaAffinity(handleModelEndpointsRequest);
