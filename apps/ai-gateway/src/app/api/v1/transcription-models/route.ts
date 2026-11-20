import { handleTranscriptionModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/transcription-models';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { withReplicaAffinity } from '../with-replica-affinity';

export const GET = withReplicaAffinity(
  withRestTiming('/api/v1/transcription-models', handleTranscriptionModelsRequest)
);
