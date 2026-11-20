import { handleEditCompletionsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/edit-completions';
import { withReplicaAffinity } from '../../with-replica-affinity';

export const POST = withReplicaAffinity(handleEditCompletionsRequest);

export const maxDuration = 800;
