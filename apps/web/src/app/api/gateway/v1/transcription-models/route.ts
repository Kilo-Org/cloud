import { GET as gatewayTranscriptionModelsGet } from '@/app/api/gateway/transcription-models/route';
import { withRestTiming } from '@/lib/observability/request-timing';

// Re-wrap the already timed handler so the v1 alias emits its own line.
export const GET = withRestTiming(
  '/api/gateway/v1/transcription-models',
  gatewayTranscriptionModelsGet
);
