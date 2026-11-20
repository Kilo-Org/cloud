import { handleModelValidationRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/model-validation';
import { withReplicaAffinity } from '../../with-replica-affinity';

export const POST = withReplicaAffinity(handleModelValidationRequest);
