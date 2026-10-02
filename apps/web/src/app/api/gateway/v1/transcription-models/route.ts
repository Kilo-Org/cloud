import { handleTranscriptionModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/transcription-models';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

export const GET = withRestTiming(
  '/api/gateway/v1/transcription-models',
  handleTranscriptionModelsRequest
);
