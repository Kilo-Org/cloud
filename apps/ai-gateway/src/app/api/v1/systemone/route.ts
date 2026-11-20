import { handleSystemOneRequest } from '@kilocode/web-shared/lib/ai-gateway/typesafe/handler';
import { withReplicaAffinity } from '../with-replica-affinity';

export const POST = withReplicaAffinity(handleSystemOneRequest);

export const maxDuration = 800;
