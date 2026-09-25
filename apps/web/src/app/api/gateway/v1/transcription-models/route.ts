import { handleTranscriptionModelsRequest } from '@/lib/ai-gateway/handlers/transcription-models';
import { withRestTiming } from '@/lib/observability/request-timing';

export const GET = withRestTiming(
  '/api/gateway/v1/transcription-models',
  handleTranscriptionModelsRequest
);
