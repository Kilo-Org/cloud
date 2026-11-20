import { handleOrganizationModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/organization-models';
import { withReplicaAffinity } from '../../../with-replica-affinity';

export const GET = withReplicaAffinity(handleOrganizationModelsRequest);
