import { handleEmbeddingsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/embeddings';
import { withReplicaAffinity } from '../with-replica-affinity';

export const POST = withReplicaAffinity(handleEmbeddingsRequest);

export const maxDuration = 800;
