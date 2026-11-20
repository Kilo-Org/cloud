import { handleModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/models';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { withReplicaAffinity } from '../with-replica-affinity';

export const GET = withReplicaAffinity(withRestTiming('/api/v1/models', handleModelsRequest));
