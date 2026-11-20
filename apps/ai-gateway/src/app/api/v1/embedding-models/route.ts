import { handleEmbeddingModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/embedding-models';
import { withReplicaAffinity } from '../with-replica-affinity';

export const GET = withReplicaAffinity(handleEmbeddingModelsRequest);
