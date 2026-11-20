import { handleAutoRoutingDeniedModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/auto-routing-denied-models';
import { withReplicaAffinity } from '../../../with-replica-affinity';

export const POST = withReplicaAffinity(handleAutoRoutingDeniedModelsRequest);
