import { GET as openRouterTranscriptionModelsGet } from '@/app/api/openrouter/transcription-models/route';
import { withRestTiming } from '@/lib/observability/request-timing';

// Re-wrap the already timed handler so the v1 alias emits its own line.
export const GET = withRestTiming(
  '/api/openrouter/v1/transcription-models',
  openRouterTranscriptionModelsGet
);
