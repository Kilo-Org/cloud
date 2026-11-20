import { handleOrganizationModelValidationRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/organization-model-validation';
import { withReplicaAffinity } from '../../../../with-replica-affinity';

export const POST = withReplicaAffinity(handleOrganizationModelValidationRequest);
