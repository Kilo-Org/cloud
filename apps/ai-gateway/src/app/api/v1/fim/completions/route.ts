import { handleFimCompletionsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/fim-completions';
import { withReplicaAffinity } from '../../with-replica-affinity';

export const POST = withReplicaAffinity(handleFimCompletionsRequest);

export const maxDuration = 800;
