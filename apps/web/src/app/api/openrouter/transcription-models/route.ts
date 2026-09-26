import { GET as gatewayTranscriptionModelsGet } from '@/app/api/gateway/transcription-models/route';
import { withRestTiming } from '@/lib/observability/request-timing';

export const GET = withRestTiming(
  '/api/openrouter/transcription-models',
  gatewayTranscriptionModelsGet
);
